package filedata

import (
	"math"
	"regexp"

	"github.com/ente/museum/ente"
)

const smallVideoPreviewSize = 200_000_000

var videoPreviewObjectIDPattern = regexp.MustCompile(`^pv_[0-9A-Za-z]{22}$`)

type VidPreviewRequest struct {
	FileID         int64  `json:"fileID" binding:"required"`
	ObjectID       string `json:"objectID" binding:"required"`
	ObjectSize     int64  `json:"objectSize" binding:"required"`
	Playlist       string `json:"playlist" binding:"required"`
	PlayListHeader string `json:"playlistHeader" binding:"required"`
	Version        *int   `json:"version"`
}

func (r VidPreviewRequest) Validate() error {
	if r.ObjectSize <= 0 {
		return ente.NewBadRequestWithMessage("objectSize must be positive for preview video")
	}
	if r.Playlist == "" || r.PlayListHeader == "" {
		return ente.NewBadRequestWithMessage("playlist and playListHeader are required for preview video")
	}
	if !videoPreviewObjectIDPattern.MatchString(r.ObjectID) {
		return ente.NewBadRequestWithMessage("invalid video preview object ID")
	}
	return nil
}

func (r VidPreviewRequest) ValidateSize(originalSize int64) error {
	if originalSize <= 0 {
		return ente.NewBadRequestWithMessage("original file size is unavailable for preview video")
	}
	if r.ObjectSize <= 0 {
		return ente.NewBadRequestWithMessage("objectSize must be positive for preview video")
	}
	if originalSize > math.MaxInt64/3 || r.ObjectSize <= 3*originalSize {
		return nil
	}
	if r.ObjectSize < smallVideoPreviewSize && r.ObjectSize/4 < originalSize {
		return nil
	}
	return ente.NewBadRequestWithMessage("video preview exceeds the allowed size relative to the original file")
}

// DropOriginalRequest asks for the original objects of the given videos to be
// deleted, keeping only their HLS streams.
type DropOriginalRequest struct {
	FileIDs []int64 `json:"fileIDs" binding:"required"`
}

func (r DropOriginalRequest) Validate() error {
	if len(r.FileIDs) == 0 {
		return ente.NewBadRequestWithMessage("fileIDs are required")
	}
	if len(r.FileIDs) > 200 {
		return ente.NewBadRequestWithMessage("fileIDs should be less than or equal to 200")
	}
	return nil
}

// DropOriginalSkip records a file whose original was left in place, and why.
type DropOriginalSkip struct {
	FileID int64  `json:"fileID"`
	Reason string `json:"reason"`
}

type DropOriginalResponse struct {
	Dropped []int64            `json:"dropped"`
	Skipped []DropOriginalSkip `json:"skipped"`
}
