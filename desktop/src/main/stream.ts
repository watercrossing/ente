import { net, protocol, type BrowserWindow } from "electron/main";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import log from "./log";
import { ffmpegUtilityProcess } from "./services/ffmpeg";
import { type FFmpegGenerateHLSPlaylistAndSegmentsResult } from "./services/ffmpeg-worker";
import { markClosableZip, openZip } from "./services/zip";
import { writeStream } from "./utils/stream";
import {
    deleteTempDirIgnoringErrors,
    deleteTempFile,
    deleteTempFileIgnoringErrors,
    makeFileForStreamOrPathOrZipItem,
    makeTempFilePath,
} from "./utils/temp";

// This protocol avoids contextBridge's buffer copies for large files.
export const registerStreamProtocol = (mainWindow: BrowserWindow) => {
    protocol.handle("stream", (request: Request) => {
        try {
            return handleStreamRequest(mainWindow, request);
        } catch (e) {
            log.error(`Failed to handle stream request for ${request.url}`, e);
            return new Response(String(e), { status: 500 });
        }
    });
};

const rendererOrigin = "ente://app";

const handleStreamRequest = async (
    mainWindow: BrowserWindow,
    request: Request,
): Promise<Response> => {
    // Custom-scheme requests omit Origin and Referer, so gate them by the
    // document loaded in the app's only window.
    const windowURL = mainWindow.webContents.getURL();
    if (
        windowURL != rendererOrigin &&
        !windowURL.startsWith(`${rendererOrigin}/`)
    )
        return new Response("", { status: 403 });

    const url = request.url;

    const { host, searchParams } = new URL(url);
    switch (host) {
        case "read":
            return handleRead(searchParams.get("path")!);

        case "read-zip":
            return handleReadZip(
                searchParams.get("zipPath")!,
                searchParams.get("entryName")!,
            );

        case "write":
            return handleWrite(searchParams.get("path")!, request);

        case "video": {
            const op = searchParams.get("op");
            if (op) {
                switch (op) {
                    case "convert-to-mp4":
                        return handleConvertToMP4Write(request);
                    case "generate-hls":
                        return handleGenerateHLSWrite(request, searchParams);
                    case "merge-hls":
                        return handleMergeHLSWrite(request, searchParams);
                    default:
                        return new Response(`Unknown op ${op}`, {
                            status: 404,
                        });
                }
            }

            const token = searchParams.get("token");
            const done = searchParams.get("done") !== null;
            if (!token) {
                return new Response("Missing token", { status: 404 });
            }

            return done ? handleVideoDone(token) : handleVideoRead(token);
        }

        default:
            return new Response("", { status: 404 });
    }
};

const handleRead = async (path: string) => {
    const res = await net.fetch(pathToFileURL(path).toString());
    if (res.ok) {
        const stat = await fs.stat(path);

        const fileSize = stat.size;
        res.headers.set("Content-Length", `${fileSize}`);

        const mtimeMs = stat.mtime.getTime();
        res.headers.set("X-Last-Modified-Ms", `${mtimeMs}`);
    }
    return res;
};

const handleReadZip = async (zipPath: string, entryName: string) => {
    const zip = openZip(zipPath);
    const entry = await zip.entry(entryName);
    if (!entry) {
        markClosableZip(zipPath);
        return new Response("", { status: 404 });
    }

    const { writable, readable } = new TransformStream();
    const stream = await zip.stream(entry);

    // Node and DOM disagree about WritableStream.close's Promise return.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const nodeWritable = Writable.fromWeb(writable as any);
    stream.pipe(nodeWritable);

    nodeWritable.on("error", (e: unknown) => {
        // Closing the response body early aborts the writable side.
        if (e instanceof Error && e.name == "AbortError") return;
        log.error("Error event for the writable end of zip stream", e);
    });

    nodeWritable.on("close", () => {
        markClosableZip(zipPath);
    });

    // node-stream-zip's parseZipTime returns epoch milliseconds.
    const modifiedMs = entry.time;

    return new Response(readable, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": `${entry.size}`,
            "X-Last-Modified-Ms": `${modifiedMs}`,
        },
    });
};

const handleWrite = async (path: string, request: Request) => {
    await writeStream(path, request.body!);
    return new Response("", { status: 200 });
};

// Chromium cannot stream both halves of one fetch. Video operations return a
// token for a second read request; a final done request releases the temp file.
const pendingVideoResults = new Map<string, string>();

export const clearPendingVideoResults = () => pendingVideoResults.clear();

const handleConvertToMP4Write = async (request: Request) => {
    const worker = await ffmpegUtilityProcess();

    const inputTempFilePath = await makeTempFilePath();
    await writeStream(inputTempFilePath, request.body!);

    const outputTempFilePath = await makeTempFilePath("mp4");
    try {
        await worker.ffmpegConvertToMP4(inputTempFilePath, outputTempFilePath);
    } catch (e) {
        log.error("Conversion to MP4 failed", e);
        await deleteTempFileIgnoringErrors(outputTempFilePath);
        throw e;
    } finally {
        await deleteTempFileIgnoringErrors(inputTempFilePath);
    }

    const token = randomUUID();
    pendingVideoResults.set(token, outputTempFilePath);
    return new Response(token, { status: 200 });
};

const handleVideoRead = async (token: string) => {
    const filePath = pendingVideoResults.get(token);
    if (!filePath)
        return new Response(`Unknown token ${token}`, { status: 404 });

    return net.fetch(pathToFileURL(filePath).toString());
};

const handleVideoDone = async (token: string) => {
    const filePath = pendingVideoResults.get(token);
    if (!filePath)
        return new Response(`Unknown token ${token}`, { status: 404 });

    await deleteTempFile(filePath);

    pendingVideoResults.delete(token);
    return new Response("", { status: 200 });
};

const handleGenerateHLSWrite = async (
    request: Request,
    params: URLSearchParams,
) => {
    const fileID = parseInt(params.get("fileID") ?? "", 10);
    const fetchURL = params.get("fetchURL");
    const authToken = params.get("authToken");
    if (!fileID || !fetchURL || !authToken) throw new Error("Missing params");

    let inputItem: Parameters<typeof makeFileForStreamOrPathOrZipItem>[0];
    const path = params.get("path");
    if (path) {
        inputItem = path;
    } else {
        const zipPath = params.get("zipPath");
        const entryName = params.get("entryName");
        if (zipPath && entryName) {
            inputItem = [zipPath, entryName];
        } else {
            const body = request.body;
            if (!body) throw new Error("Missing body");
            inputItem = body;
        }
    }

    const worker = await ffmpegUtilityProcess();

    const {
        path: inputFilePath,
        isFileTemporary: isInputFileTemporary,
        writeToTemporaryFile: writeToTemporaryInputFile,
    } = await makeFileForStreamOrPathOrZipItem(inputItem);

    const outputFilePathPrefix = await makeTempFilePath();
    let result: FFmpegGenerateHLSPlaylistAndSegmentsResult | undefined;
    try {
        await writeToTemporaryInputFile();

        result = await worker.ffmpegGenerateHLSPlaylistAndSegments(
            inputFilePath,
            outputFilePathPrefix,
            fileID,
            fetchURL,
            authToken,
        );

        if (!result) {
            return new Response(null, { status: 204 });
        }

        const {
            playlistPath,
            dimensions,
            videoSize,
            videoObjectID,
            isLosslessCopy,
        } = result;

        const playlistToken = randomUUID();
        pendingVideoResults.set(playlistToken, playlistPath);

        return new Response(
            JSON.stringify({
                playlistToken,
                dimensions,
                videoSize,
                videoObjectID,
                isLosslessCopy,
            }),
            { status: 200 },
        );
    } finally {
        if (isInputFileTemporary)
            await deleteTempFileIgnoringErrors(inputFilePath);
    }
};

/**
 * Stitch an HLS stream back into a standalone video file at a path of the
 * renderer's choosing.
 *
 * The request body is the encrypted MPEG-TS object backing the stream, and the
 * "playlist" param is the m3u8 that indexes into it. Both are written into a
 * temporary directory, using the names the playlist expects, before ffmpeg is
 * asked to put them back together.
 *
 * Unlike the other video ops, the result is written directly to the "outputPath"
 * the user picked instead of being handed back via a token: these files are
 * arbitrarily large, and there is no reason to make a temporary copy of one.
 */
const handleMergeHLSWrite = async (
    request: Request,
    params: URLSearchParams,
) => {
    const playlist = params.get("playlist");
    const outputPath = params.get("outputPath");
    if (!playlist || !outputPath) throw new Error("Missing params");

    const body = request.body;
    if (!body) throw new Error("Missing body");

    const worker = await ffmpegUtilityProcess();

    const tempDirPath = await makeTempFilePath();
    await fs.mkdir(tempDirPath);

    // Playlists index into a video named "output.ts" alongside them (see the
    // corresponding assumption in the web code's hlsPlaylistDataForFile).
    const playlistPath = path.join(tempDirPath, "output.m3u8");
    const videoPath = path.join(tempDirPath, "output.ts");

    const { playlist: demuxablePlaylist, key } = detachInlineHLSKey(playlist);

    let didStartMerge = false;
    try {
        await Promise.all([
            fs.writeFile(playlistPath, demuxablePlaylist, { encoding: "utf8" }),
            key
                ? fs.writeFile(path.join(tempDirPath, hlsKeyFileName), key)
                : Promise.resolve(),
            writeStream(videoPath, body),
        ]);

        didStartMerge = true;
        await worker.ffmpegMergeHLSStream(playlistPath, outputPath);
    } catch (e) {
        log.error("Failed to merge HLS stream", e);
        // Don't leave a partial file behind at the path the user picked. Only
        // ours though: until ffmpeg starts, nothing there is of our making.
        if (didStartMerge) {
            try {
                await fs.rm(outputPath, { force: true });
            } catch (e2) {
                log.error(`Could not delete incomplete file ${outputPath}`, e2);
            }
        }
        throw e;
    } finally {
        await deleteTempDirIgnoringErrors(tempDirPath);
    }

    return new Response("", { status: 200 });
};

const hlsKeyFileName = "output.key";

const inlineHLSKeyURIRegex = /URI="data:[^;"]*;base64,([^"]+)"/g;

/**
 * Move the AES key that a playlist inlines as a data URI out into a file that
 * sits alongside the playlist.
 *
 * We generate playlists with their key inlined, which is what the HLS clients
 * we play them back with expect. ffmpeg's HLS demuxer is stricter, and will
 * fetch keys only over file or http, so for its benefit the key gets its own
 * file and the playlist is rewritten to point at it.
 *
 * Playlists which do not inline a key (or do not use one at all) are returned
 * unchanged.
 */
const detachInlineHLSKey = (playlist: string) => {
    let key: Buffer | undefined;
    const rewritten = playlist.replaceAll(
        inlineHLSKeyURIRegex,
        (_, base64Key: string) => {
            // All our segments share one key, so the first is representative.
            key ??= Buffer.from(base64Key, "base64");
            return `URI="${hlsKeyFileName}"`;
        },
    );
    return key ? { playlist: rewritten, key } : { playlist, key };
};
