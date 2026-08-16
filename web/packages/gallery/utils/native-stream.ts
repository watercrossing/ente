import type { Electron, ElectronMLWorker, ZipItem } from "ente-base/types/ipc";
import { z } from "zod";
import type { FileSystemUploadItem } from "../services/upload";

// Electron arguments prove these are desktop calls.
// The native protocol handlers do not otherwise use them.
export const readStream = async (
    _: Electron | ElectronMLWorker,
    pathOrZipItem: string | ZipItem,
): Promise<{ response: Response; size: number; lastModifiedMs: number }> => {
    let url: URL;
    if (typeof pathOrZipItem == "string") {
        const params = new URLSearchParams({ path: pathOrZipItem });
        url = new URL(`stream://read?${params.toString()}`);
    } else {
        const [zipPath, entryName] = pathOrZipItem;
        const params = new URLSearchParams({ zipPath, entryName });
        url = new URL(`stream://read-zip?${params.toString()}`);
    }

    const req = new Request(url, { method: "GET" });

    const res = await fetch(req);
    if (!res.ok)
        throw new Error(
            `Failed to read stream from ${url.href}: HTTP ${res.status}`,
        );

    const size = readNumericHeader(res, "Content-Length");
    const lastModifiedMs = readNumericHeader(res, "X-Last-Modified-Ms");

    return { response: res, size, lastModifiedMs };
};

const readNumericHeader = (res: Response, key: string) => {
    const valueText = res.headers.get(key);
    const value = valueText === null ? NaN : +valueText;
    if (isNaN(value))
        throw new Error(
            `Expected a numeric ${key} when reading a stream response, instead got ${valueText}`,
        );
    return value;
};

export const writeStream = async (
    _: Electron,
    path: string,
    stream: ReadableStream | null,
) => {
    const params = new URLSearchParams({ path });
    const url = new URL(`stream://write?${params.toString()}`);

    const req = new Request(url, {
        method: "POST",
        // Chromium requires duplex for streamed request bodies.
        // @ts-expect-error duplex is missing from lib.dom.d.ts.
        duplex: "half",
        body: stream,
    });

    const res = await fetch(req);
    if (!res.ok)
        throw new Error(
            `Failed to write stream to ${url.href}: HTTP ${res.status}`,
        );
};

export const initiateConvertToMP4 = async (
    _: Electron,
    video: Blob,
): Promise<string> => {
    const url = "stream://video?op=convert-to-mp4";
    const res = await fetch(url, { method: "POST", body: video });
    if (!res.ok)
        throw new Error(`Failed to write stream to ${url}: HTTP ${res.status}`);
    return res.text();
};

const GenerateHLSResult = z.object({
    playlistToken: z.string(),
    dimensions: z.object({ width: z.number(), height: z.number() }),
    videoSize: z.number(),
    videoObjectID: z.string(),
    // Absent when talking to an older desktop app, which is indistinguishable
    // here from a stream that is not a faithful copy of its original.
    isLosslessCopy: z.boolean().optional(),
});

export type GenerateHLSResult = z.infer<typeof GenerateHLSResult>;

export const initiateGenerateHLS = async (
    _: Electron,
    video: FileSystemUploadItem | ReadableStream,
    fileID: number,
    fetchURL: string,
    authToken: string,
): Promise<GenerateHLSResult | undefined> => {
    const params = new URLSearchParams({
        op: "generate-hls",
        fileID: fileID.toString(),
        fetchURL,
        authToken,
    });

    let body: ReadableStream | null;
    if (video instanceof ReadableStream) {
        body = video;
    } else {
        body = null;
        if (typeof video == "string") {
            params.set("path", video);
        } else if (Array.isArray(video)) {
            const [zipPath, entryName] = video;
            params.set("zipPath", zipPath);
            params.set("entryName", entryName);
        } else {
            params.set("path", video.path);
        }
    }

    const url = `stream://video?${params.toString()}`;
    const res = await fetch(url, {
        method: "POST",
        // Chromium requires duplex for streamed request bodies.
        // @ts-expect-error duplex is missing from lib.dom.d.ts.
        duplex: "half",
        body,
    });
    if (!res.ok)
        throw new Error(`Failed to write stream to ${url}: HTTP ${res.status}`);

    // 204 means the original video can be streamed as-is.
    if (res.status == 204) return undefined;

    return GenerateHLSResult.parse(await res.json());
};

/**
 * Ask native to stitch an HLS stream back into a standalone MP4 on disk.
 *
 * This is only expected to be used with streams that we ourselves generated,
 * whose playlists index into a single encrypted video and carry their key
 * inline. Native does the reassembly with ffmpeg, copying the streams across
 * without a re-encode.
 *
 * @param playlist The m3u8 playlist for the stream, retaining the relative
 * "output.ts" URI for the video that native will write {@link video} to. The
 * body is taken by the video, so this rides along in the URL; playlists run to
 * tens of bytes per segment, far below what Chromium will carry there.
 *
 * @param video A stream of the bytes of the video that the playlist indexes
 * into.
 *
 * @param outputPath Path at which to write the resultant MP4. Anything already
 * there will be overwritten.
 */
export const mergeHLSStream = async (
    _: Electron,
    playlist: string,
    video: ReadableStream,
    outputPath: string,
): Promise<void> => {
    const params = new URLSearchParams({
        op: "merge-hls",
        playlist,
        outputPath,
    });

    const url = `stream://video?${params.toString()}`;
    const res = await fetch(url, {
        method: "POST",
        // Chromium requires duplex for streamed request bodies.
        // @ts-expect-error duplex is missing from lib.dom.d.ts.
        duplex: "half",
        body: video,
    });
    if (!res.ok)
        throw new Error(`Failed to write stream to ${url}: HTTP ${res.status}`);
};

export const readVideoStream = async (
    _: Electron,
    token: string,
): Promise<Response> => {
    const params = new URLSearchParams({ token });
    const url = new URL(`stream://video?${params.toString()}`);

    const req = new Request(url, { method: "GET" });

    const res = await fetch(req);
    if (!res.ok)
        throw new Error(
            `Failed to read stream from ${url.href}: HTTP ${res.status}`,
        );

    return res;
};

// Call this after readVideoStream so native temporary files are released.
export const videoStreamDone = async (
    _: Electron,
    token: string,
): Promise<void> => {
    // Native checks only for the presence of done.
    const params = new URLSearchParams({ token, done: "1" });
    const url = new URL(`stream://video?${params.toString()}`);

    const req = new Request(url, { method: "GET" });
    const res = await fetch(req);
    if (!res.ok)
        throw new Error(
            `Failed to close stream at ${url.href}: HTTP ${res.status}`,
        );
};
