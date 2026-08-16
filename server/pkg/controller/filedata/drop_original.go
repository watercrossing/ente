package filedata

import (
	"fmt"

	"github.com/ente/museum/ente"
	fileData "github.com/ente/museum/ente/filedata"
	"github.com/ente/stacktrace"
	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

// DropOriginals deletes the original object of each of the given videos,
// keeping the file, its thumbnail and its HLS stream.
//
// It is meant for videos whose stream is a lossless copy of the original, so
// that the original can be reconstructed by remuxing the stream. The client
// decides that (only it can see the video), but the checks here are what stop a
// mistaken or malicious request from destroying the only copy of a video: the
// stream must exist, and be present in every bucket this deployment stores
// preview video in, at its recorded size.
//
// The original is not removed from the bucket immediately. It is soft deleted
// and queued, so it remains recoverable for the DeleteObjectQueue delay.
func (c *Controller) DropOriginals(ctx *gin.Context, userID int64, fileIDs []int64) (*fileData.DropOriginalResponse, error) {
	res := &fileData.DropOriginalResponse{
		Dropped: make([]int64, 0),
		Skipped: make([]fileData.DropOriginalSkip, 0),
	}

	rowByFileID := make(map[int64]fileData.Row)
	rows, err := c.Repo.GetFilesData(ctx, ente.PreviewVideo, fileIDs)
	if err != nil {
		return nil, stacktrace.Propagate(err, "failed to fetch preview rows")
	}
	for _, row := range rows {
		rowByFileID[row.FileID] = row
	}

	for _, fileID := range fileIDs {
		skip := func(reason string) {
			log.WithFields(log.Fields{
				"file_id": fileID,
				"user_id": userID,
			}).Warnf("Not dropping original: %s", reason)
			res.Skipped = append(res.Skipped, fileData.DropOriginalSkip{
				FileID: fileID, Reason: reason,
			})
		}

		ownerID, err := c.FileRepo.GetOwnerID(fileID)
		if err != nil {
			return nil, stacktrace.Propagate(err, "failed to determine owner of %d", fileID)
		}
		if ownerID != userID {
			return nil, stacktrace.Propagate(ente.ErrPermissionDenied, "user %d does not own file %d", userID, fileID)
		}

		row, ok := rowByFileID[fileID]
		if !ok {
			skip("no video preview exists for this file")
			continue
		}
		if row.IsDeleted {
			skip("the video preview is marked as deleted")
			continue
		}
		if row.UserID != ownerID {
			skip("the video preview belongs to a different user")
			continue
		}
		if row.ObjectID == nil || row.ObjectSize == nil {
			skip("the video preview has no object recorded against it")
			continue
		}
		if err := c.verifyPreviewIsDurable(row); err != nil {
			skip(err.Error())
			continue
		}

		if err := c.FileRepo.DropOriginal(ctx, fileID, userID); err != nil {
			return nil, stacktrace.Propagate(err, "failed to drop original of %d", fileID)
		}

		log.WithFields(log.Fields{
			"file_id": fileID,
			"user_id": userID,
		}).Info("Dropped original, retaining video preview")
		res.Dropped = append(res.Dropped, fileID)
	}

	return res, nil
}

// verifyPreviewIsDurable establishes that the stream is somewhere we can still
// read it from after the original goes away: both of its objects, the playlist
// metadata and the video, present at their recorded sizes in every bucket this
// deployment keeps preview video in.
//
// pending_sync deliberately plays no part in that. It is the replication
// queue's own flag, and nothing clears it while replication is disabled, which
// is the usual case for a deployment with a single bucket. Asking the buckets
// themselves is better evidence than the row's own bookkeeping anyway.
func (c *Controller) verifyPreviewIsDurable(row fileData.Row) error {
	// Deployments without replica buckets configured for preview video want it
	// in the primary bucket alone, which makes this loop a no-op for them.
	have := map[string]bool{row.LatestBucket: true}
	for _, bucketID := range row.ReplicatedBuckets {
		have[bucketID] = true
	}
	want := append(
		[]string{c.S3Config.GetBucketID(ente.PreviewVideo)},
		c.S3Config.GetReplicatedBuckets(ente.PreviewVideo)...,
	)
	for _, bucketID := range want {
		if !have[bucketID] {
			return fmt.Errorf("the video preview has not been replicated to %s yet", bucketID)
		}
	}

	// The row saying the objects exist is not the same as them existing. This
	// is the last chance to find out before the original is unrecoverable, so
	// ask each bucket rather than trust what the row claims about it.
	playlistSize := row.Size - *row.ObjectSize
	for _, bucketID := range want {
		if err := c.verifySize(bucketID, row.S3FileMetadataObjectKey(), playlistSize); err != nil {
			return fmt.Errorf("the video preview playlist could not be verified in %s: %v", bucketID, err)
		}
		if err := c.verifySize(bucketID, row.GetS3FileObjectKey(), *row.ObjectSize); err != nil {
			return fmt.Errorf("the video preview object could not be verified in %s: %v", bucketID, err)
		}
	}

	return nil
}
