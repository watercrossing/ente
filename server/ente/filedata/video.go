package filedata

import "github.com/ente/museum/ente"

type VidPreviewRequest struct {
	FileID         int64  `json:"fileID" binding:"required"`
	ObjectID       string `json:"objectID" binding:"required"`
	ObjectSize     int64  `json:"objectSize" binding:"required"`
	Playlist       string `json:"playlist" binding:"required"`
	PlayListHeader string `json:"playlistHeader" binding:"required"`
	Version        *int   `json:"version"`
}

func (r VidPreviewRequest) Validate() error {
	if r.Playlist == "" || r.PlayListHeader == "" {
		return ente.NewBadRequestWithMessage("playlist and playListHeader are required for preview video")
	}
	return nil
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
