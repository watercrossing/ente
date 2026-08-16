import { safeDirectoryName, safeFileName } from "@/utils/native-fs";
import { assertionFailed } from "ente-base/assert";
import { suppressMainWindowBlurForTrustedPrompt } from "ente-base/electron";
import { joinPath, nameAndExtension } from "ente-base/file-name";
import log from "ente-base/log";
import type { Electron } from "ente-base/types/ipc";
import type {
    AddSaveGroup,
    UpdateSaveGroup,
} from "ente-gallery/components/utils/save-groups";
import { downloadManager } from "ente-gallery/services/download";
import { downloadAndSaveFilesWeb } from "ente-gallery/services/save-core";
import { hlsSourceForFileIfExists } from "ente-gallery/services/video";
import { mergeHLSStream, writeStream } from "ente-gallery/utils/native-stream";
import { fileLogID, type EnteFile } from "ente-media/file";
import { fileFileName, isStreamOnlyVideo } from "ente-media/file-metadata";
import { FileType } from "ente-media/file-type";
import { decodeLivePhoto } from "ente-media/live-photo";

export const downloadAndSaveFiles = (
    files: EnteFile[],
    title: string,
    onAddSaveGroup: AddSaveGroup,
) => downloadAndSave(files, title, onAddSaveGroup);

export const downloadAndSaveCollectionFiles = async (
    collectionSummaryName: string,
    collectionSummaryID: number,
    files: EnteFile[],
    isHiddenCollectionSummary: boolean | undefined,
    onAddSaveGroup: AddSaveGroup,
) =>
    downloadAndSave(
        files,
        collectionSummaryName,
        onAddSaveGroup,
        collectionSummaryName,
        collectionSummaryID,
        isHiddenCollectionSummary,
    );

const downloadAndSave = async (
    files: EnteFile[],
    title: string,
    onAddSaveGroup: AddSaveGroup,
    collectionSummaryName?: string,
    collectionSummaryID?: number,
    isHiddenCollectionSummary?: boolean,
) => {
    const electron = globalThis.electron;
    if (!electron) {
        return downloadAndSaveFilesWeb({
            downloader: downloadManager,
            files,
            title,
            onAddSaveGroup,
            collectionSummaryID,
            isHiddenCollectionSummary,
        });
    }

    const total = files.length;
    if (!files.length) {
        assertionFailed();
        return;
    }

    suppressMainWindowBlurForTrustedPrompt();
    const selectedDirPath = await electron.selectDirectory();
    if (!selectedDirPath) {
        return;
    }
    const downloadDirPath = collectionSummaryName
        ? await mkdirCollectionDownloadFolder(
              electron,
              selectedDirPath,
              collectionSummaryName,
          )
        : selectedDirPath;

    const canceller = new AbortController();
    const failedFiles: EnteFile[] = [];
    let isDownloading = false;
    let updateSaveGroup: UpdateSaveGroup = () => undefined;

    const downloadFilesDesktop = async (
        filesToDownload: EnteFile[],
        resetFailedCount = false,
    ) => {
        if (!filesToDownload.length || isDownloading) return;

        isDownloading = true;
        if (resetFailedCount) {
            updateSaveGroup((g) => ({ ...g, failed: 0 }));
        }
        failedFiles.length = 0;

        try {
            for (const file of filesToDownload) {
                if (canceller.signal.aborted) break;
                try {
                    await saveFileDesktop(electron, file, downloadDirPath);
                    updateSaveGroup((g) => ({ ...g, success: g.success + 1 }));
                } catch (e) {
                    log.error("File download failed", e);
                    failedFiles.push(file);
                    updateSaveGroup((g) => ({ ...g, failed: g.failed + 1 }));
                }
            }

            if (!failedFiles.length) {
                updateSaveGroup((g) => ({ ...g, retry: undefined }));
            }
        } finally {
            isDownloading = false;
        }
    };

    const retry = () => {
        if (!failedFiles.length || isDownloading || canceller.signal.aborted)
            return;
        void downloadFilesDesktop([...failedFiles], true);
    };

    updateSaveGroup = onAddSaveGroup({
        title,
        collectionSummaryID,
        isHiddenCollectionSummary,
        downloadDirPath,
        total,
        includeZipNumber: false,
        canceller,
        retry,
    });

    await downloadFilesDesktop(files);
};

/**
 * Save the streamable version of each of the given videos to a directory the
 * user picks, stitched back into a standalone MP4.
 *
 * This is a desktop only operation, since the stitching is done natively by
 * ffmpeg. Videos which do not have a stream (either because they don't need one
 * or because one hasn't been generated yet) are counted as failures.
 *
 * Note that what gets saved is not the original video but the smaller,
 * transcoded one that gets streamed during playback. So this is a way of
 * obtaining a compact and broadly playable copy of a video without having to
 * download the original.
 */
export const downloadAndSaveStreamableVideos = async (
    files: EnteFile[],
    title: string,
    onAddSaveGroup: AddSaveGroup,
) => {
    const electron = globalThis.electron;
    if (!electron || !files.length) {
        assertionFailed();
        return;
    }

    suppressMainWindowBlurForTrustedPrompt();
    const downloadDirPath = await electron.selectDirectory();
    if (!downloadDirPath) {
        return;
    }

    const canceller = new AbortController();
    const failedFiles: EnteFile[] = [];
    let isDownloading = false;
    let updateSaveGroup: UpdateSaveGroup = () => undefined;

    const saveStreams = async (
        filesToSave: EnteFile[],
        resetFailedCount = false,
    ) => {
        if (!filesToSave.length || isDownloading) return;

        isDownloading = true;
        if (resetFailedCount) {
            updateSaveGroup((g) => ({
                ...g,
                failed: 0,
                failureReason: undefined,
            }));
        }
        failedFiles.length = 0;

        try {
            for (const file of filesToSave) {
                if (canceller.signal.aborted) break;
                try {
                    await saveStreamableVideoDesktop(
                        electron,
                        file,
                        downloadDirPath,
                        canceller.signal,
                    );
                    updateSaveGroup((g) => ({ ...g, success: g.success + 1 }));
                } catch (e) {
                    log.error(
                        `Failed to save stream for ${fileLogID(file)}`,
                        e,
                    );
                    failedFiles.push(file);
                    updateSaveGroup((g) => ({
                        ...g,
                        failed: g.failed + 1,
                        failureReason: g.failureReason ?? "file_error",
                    }));
                }
            }

            if (!failedFiles.length) {
                updateSaveGroup((g) => ({ ...g, retry: undefined }));
            }
        } finally {
            isDownloading = false;
        }
    };

    const retry = () => {
        if (!failedFiles.length || isDownloading || canceller.signal.aborted)
            return;
        void saveStreams([...failedFiles], true);
    };

    updateSaveGroup = onAddSaveGroup({
        title,
        downloadDirPath,
        total: files.length,
        includeZipNumber: false,
        canceller,
        retry,
    });

    await saveStreams(files);
};

const saveStreamableVideoDesktop = async (
    electron: Electron,
    file: EnteFile,
    directoryPath: string,
    signal: AbortSignal,
) => {
    const source = await hlsSourceForFileIfExists(file);
    if (!source) {
        throw new Error(`No stream exists for ${fileLogID(file)}`);
    }

    const res = await fetch(source.videoURL, { signal });
    if (!res.ok || !res.body) {
        throw new Error(
            `Failed to fetch the stream for ${fileLogID(file)}: HTTP ${res.status}`,
        );
    }

    // The stream is always an MP4-able H.264 + AAC, whatever the original was.
    const [name] = nameAndExtension(fileFileName(file));
    const exportName = await safeFileName(
        directoryPath,
        `${name}.mp4`,
        electron.fs.exists,
    );

    await mergeHLSStream(
        electron,
        source.playlist,
        res.body,
        joinPath(directoryPath, exportName),
    );
};

const mkdirCollectionDownloadFolder = async (
    { fs }: Electron,
    downloadDirPath: string,
    collectionName: string,
) => {
    const collectionDownloadName = await safeDirectoryName(
        downloadDirPath,
        collectionName,
        fs.exists,
    );
    const collectionDownloadPath = joinPath(
        downloadDirPath,
        collectionDownloadName,
    );
    await fs.mkdirIfNeeded(collectionDownloadPath);
    return collectionDownloadPath;
};

const saveFileDesktop = async (
    electron: Electron,
    file: EnteFile,
    directoryPath: string,
) => {
    // Videos whose original was discarded can only be saved by stitching their
    // stream back together, which is what the user gets asking to save them.
    if (isStreamOnlyVideo(file)) {
        return saveStreamableVideoDesktop(
            electron,
            file,
            directoryPath,
            new AbortController().signal,
        );
    }

    const fs = electron.fs;

    const createExportName = (fileName: string) =>
        safeFileName(directoryPath, fileName, fs.exists);

    const writeStreamToFile = (
        exportName: string,
        stream: ReadableStream<Uint8Array> | null,
    ) => writeStream(electron, joinPath(directoryPath, exportName), stream);

    const stream = await downloadManager.fileStream(file);
    const fileName = fileFileName(file);

    if (file.metadata.fileType == FileType.livePhoto) {
        const { imageFileName, imageData, videoFileName, videoData } =
            await decodeLivePhoto(fileName, await new Response(stream).blob());
        const imageExportName = await createExportName(imageFileName);
        await writeStreamToFile(imageExportName, new Response(imageData).body);
        try {
            await writeStreamToFile(
                await createExportName(videoFileName),
                new Response(videoData).body,
            );
        } catch (e) {
            await fs.rm(joinPath(directoryPath, imageExportName));
            throw e;
        }
    } else {
        await writeStreamToFile(await createExportName(fileName), stream);
    }
};
