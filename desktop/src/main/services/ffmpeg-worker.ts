import shellescape from "any-shell-escape";
import { expose } from "comlink";
import pathToFfmpeg from "ffmpeg-static";
import { randomBytes } from "node:crypto";
import fs_ from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { FFmpegCommand } from "../../types/ipc";
import log from "../log-worker";
import { messagePortMainEndpoint } from "../utils/comlink";
import { nullToUndefined, wait } from "../utils/common";
import { execAsyncWorker } from "../utils/exec-worker";
import {
    authenticatedRequestHeaders,
    publicRequestHeaders,
} from "../utils/http";

const ffmpegPathPlaceholder = "FFMPEG";
const inputPathPlaceholder = "INPUT";
const outputPathPlaceholder = "OUTPUT";

export interface FFmpegUtilityProcess {
    ffmpegExec: (
        command: FFmpegCommand,
        inputFilePath: string,
        outputFilePath: string,
    ) => Promise<void>;

    ffmpegConvertToMP4: (
        inputFilePath: string,
        outputFilePath: string,
    ) => Promise<void>;

    ffmpegGenerateHLSPlaylistAndSegments: (
        inputFilePath: string,
        outputPathPrefix: string,
        fileID: number,
        fetchURL: string,
        authToken: string,
    ) => Promise<FFmpegGenerateHLSPlaylistAndSegmentsResult | undefined>;

    ffmpegMergeHLSStream: (
        playlistFilePath: string,
        outputFilePath: string,
    ) => Promise<void>;

    ffmpegDetermineVideoDuration: (inputFilePath: string) => Promise<number>;
}

log.debugString("Started ffmpeg utility process");

process.on("uncaughtException", (e, origin) => log.error(origin, e));

process.parentPort.once("message", (e) => {
    parseInitData(e.data);
    expose(
        {
            ffmpegExec,
            ffmpegConvertToMP4,
            ffmpegGenerateHLSPlaylistAndSegments,
            ffmpegMergeHLSStream,
            ffmpegDetermineVideoDuration,
        } satisfies FFmpegUtilityProcess,
        messagePortMainEndpoint(e.ports[0]!),
    );
    mainProcess("ack", undefined);
});

let _desktopAppVersion: string | undefined;

const desktopAppVersion = () => _desktopAppVersion!;

const FFmpegWorkerInitData = z.object({ appVersion: z.string() });

const parseInitData = (data: unknown) => {
    _desktopAppVersion = FFmpegWorkerInitData.parse(data).appVersion;
};

const mainProcess = (method: string, param: unknown) =>
    process.parentPort.postMessage({ method, p: param });

const ffmpegExec = async (
    command: FFmpegCommand,
    inputFilePath: string,
    outputFilePath: string,
): Promise<void> => {
    let resolvedCommand: string[];
    if (Array.isArray(command)) {
        resolvedCommand = command;
    } else {
        const isHDR = await isHDRVideo(inputFilePath);
        resolvedCommand = isHDR ? command.hdr : command.default;
    }

    const cmd = substitutePlaceholders(
        resolvedCommand,
        inputFilePath,
        outputFilePath,
    );

    await execAsyncWorker(cmd);
};

const substitutePlaceholders = (
    command: string[],
    inputFilePath: string,
    outputFilePath: string,
) =>
    command.map((segment) => {
        if (segment == ffmpegPathPlaceholder) {
            return ffmpegBinaryPath();
        } else if (segment == inputPathPlaceholder) {
            return inputFilePath;
        } else if (segment == outputPathPlaceholder) {
            return outputFilePath;
        } else {
            return segment;
        }
    });

// Packaged dependencies live outside the archive at this rewritten path.
// https://github.com/eugeneware/ffmpeg-static/issues/16
const ffmpegBinaryPath = () => {
    return pathToFfmpeg!.replace("app.asar", "app.asar.unpacked");
};

const ffmpegConvertToMP4 = async (
    inputFilePath: string,
    outputFilePath: string,
): Promise<void> => {
    const command = [
        ffmpegPathPlaceholder,
        "-i",
        inputPathPlaceholder,
        "-preset",
        "ultrafast",
        outputPathPlaceholder,
    ];

    const cmd = substitutePlaceholders(command, inputFilePath, outputFilePath);

    await execAsyncWorker(cmd);
};

export interface FFmpegGenerateHLSPlaylistAndSegmentsResult {
    playlistPath: string;
    dimensions: { width: number; height: number };
    videoSize: number;
    videoObjectID: string;
    /**
     * If true, the generated stream carries every stream of the input, with
     * neither the video nor the audio re-encoded, and can therefore be remuxed
     * back into a file equivalent to the original.
     *
     * This is what makes it safe to discard the original. It is deliberately
     * conservative: anything we could not positively determine reads as false.
     */
    isLosslessCopy: boolean;
}

const ffmpegGenerateHLSPlaylistAndSegments = async (
    inputFilePath: string,
    outputPathPrefix: string,
    fileID: number,
    fetchURL: string,
    authToken: string,
): Promise<FFmpegGenerateHLSPlaylistAndSegmentsResult | undefined> => {
    const {
        isH264,
        isAAC,
        isHDR,
        bitrate,
        videoStreamCount,
        audioStreamCount,
        otherStreamCount,
        hasDisplayMatrix,
    } = await detectVideoCharacteristics(inputFilePath);

    const inputVideoSize = await fs.stat(inputFilePath).then((st) => st.size);

    log.info(
        `Generate HLS for file ${fileID} | source:`,
        [
            `${formatBytes(inputVideoSize)}`,
            `video ${isH264 ? "h264" : "non-h264"}${isHDR ? " HDR" : " SDR"}`,
            `audio ${isAAC ? "aac-lc" : "non-aac-lc"}`,
            bitrate ? `${Math.round(bitrate / 1000)} kb/s` : "bitrate unknown",
            `streams ${videoStreamCount}v/${audioStreamCount}a/${otherStreamCount}other`,
            hasDisplayMatrix ? "rotated" : "unrotated",
        ].join(", "),
    );

    // Never skip HEVC: it can be audio-only on Linux, and Chromium can ignore
    // iPhone HEVC+HDR rotation metadata.
    if (isH264) {
        if (inputVideoSize <= 10 * 1024 * 1024) {
            log.info(
                `Generate HLS for file ${fileID} | skipped: h264 and under 10 MB, so it can be streamed as-is`,
            );
            return undefined;
        }
    }

    // Re-encoding is by far the dominant cost of generating the stream, so
    // remux SDR H.264 regardless of its bitrate. HDR still has to be converted
    // to BT.709 SDR, which requires a re-encode.
    const reencodeVideo = !(isH264 && !isHDR);
    // AAC-LC muxes directly into the segments; anything else (including an
    // audio stream we could not identify) is transcoded for compatibility.
    const copyAudio = isAAC;
    // Avoid shrinking video whose bitrate is already modest.
    const rescaleVideo = !(bitrate && bitrate <= 2000 * 1000);
    // HDR needs BT.709 tonemapping; applying it to SDR reduces brightness.
    const tonemap = isHDR;

    log.info(
        `Generate HLS for file ${fileID} | plan:`,
        [
            reencodeVideo
                ? `re-encode video (${isHDR ? "HDR needs BT.709 tonemapping" : "not h264"})`
                : "copy video (SDR h264)",
            copyAudio ? "copy audio (aac-lc)" : "re-encode audio (not aac-lc)",
            rescaleVideo
                ? "scale to 720p"
                : "keep dimensions (bitrate already modest)",
        ].join(", "),
    );

    // The stream stands in for the original only if both codecs pass through
    // untouched and the default stream selection below has nothing to discard:
    // one video stream, one audio stream, no subtitles or data, and no rotation
    // that the segments cannot carry.
    const dropOriginalBlockers = [
        reencodeVideo && "video would be re-encoded",
        !copyAudio && "audio would be re-encoded",
        videoStreamCount != 1 && `${videoStreamCount} video streams, want 1`,
        audioStreamCount != 1 && `${audioStreamCount} audio streams, want 1`,
        otherStreamCount != 0 &&
            `${otherStreamCount} subtitle/data streams would be dropped`,
        hasDisplayMatrix && "rotation metadata would not survive MPEG-TS",
    ].filter((x) => typeof x == "string");

    const isLosslessCopy = dropOriginalBlockers.length == 0;

    log.info(
        `Generate HLS for file ${fileID} | original is`,
        isLosslessCopy
            ? "redundant: the stream is a lossless copy of it"
            : `retained: ${dropOriginalBlockers.join("; ")}`,
    );

    await fs.mkdir(outputPathPrefix);

    const playlistPath = path.join(outputPathPrefix, "output.m3u8");
    const videoPath = path.join(outputPathPrefix, "output.ts");

    // Avoid child_process's stderr buffer limit on large videos.
    const stderrPath = path.join(outputPathPrefix, "stderr.txt");

    const keyBytes = randomBytes(16);
    const keyB64 = keyBytes.toString("base64");

    const keyURI = `data:text/plain;base64,${keyB64}`;

    const keyPath = playlistPath + ".key";
    const keyInfoPath = playlistPath + ".key-info";

    // FFmpeg key-info is the playlist URI followed by the local key path.
    const keyInfo = [keyURI, keyPath].join("\n");

    const command = [
        ffmpegBinaryPath(),
        ["-hide_banner"],
        "-i",
        inputFilePath,
        reencodeVideo
            ? [
                  "-vf",
                  [
                      // Tonemapping requires dimensions divisible by chroma
                      // subsampling, so it also forces the even-size scale.
                      rescaleVideo || tonemap
                          ? [
                                "scale='if(lt(iw,ih),min(720,iw),-2)':'if(lt(iw,ih),-2,min(720,ih))'",
                                "fps=30",
                            ]
                          : [],
                      // tonemap requires linear input; the final zscale emits
                      // the broadly supported BT.709 color space.
                      tonemap
                          ? [
                                "zscale=transfer=linear",
                                "tonemap=tonemap=hable:desat=0",
                                "zscale=primaries=709:transfer=709:matrix=709",
                            ]
                          : [],
                      "format=yuv420p",
                  ]
                      .flat()
                      .join(","),
              ]
            : [],
        reencodeVideo
            ? ["-c:v", "libx264", "-maxrate", "2000k", "-bufsize", "4000k"]
            : ["-c:v", "copy"],
        ["-c:a", copyAudio ? "copy" : "aac"],
        ["-f", "hls"],
        ["-hls_key_info_file", keyInfoPath],
        ["-hls_list_size", "0"],
        ["-hls_flags", "single_file"],
        playlistPath,
    ].flat();

    let dimensions: { width: number; height: number };
    let videoSize: number;
    let videoObjectID: string;

    try {
        await Promise.all([
            fs.writeFile(keyPath, keyBytes),
            fs.writeFile(keyInfoPath, keyInfo, { encoding: "utf8" }),
        ]);

        const commandWithRedirection = `${shellescape(command)} 2>${stderrPath}`;

        await execAsyncWorker(commandWithRedirection);

        // FFmpeg-generated HLS uses LF even on Windows; fail if that changes.
        if (process.platform == "win32") {
            const playlistText = await fs.readFile(playlistPath, "utf-8");
            if (playlistText.includes("\r\n"))
                throw new Error("Unexpected Windows newlines in playlist");
        }

        dimensions = await detectVideoDimensions(stderrPath);

        videoSize = await fs.stat(videoPath).then((st) => st.size);

        log.info(
            `Generate HLS for file ${fileID} | result:`,
            [
                `${dimensions.width}x${dimensions.height}`,
                `${formatBytes(videoSize)} from ${formatBytes(inputVideoSize)}`,
                `${Math.round((videoSize / inputVideoSize) * 100)}% of the original`,
            ].join(", "),
        );

        videoObjectID = await uploadVideoSegments(
            videoPath,
            videoSize,
            fileID,
            fetchURL,
            authToken,
        );
    } catch (e) {
        log.error("HLS generation failed", e);
        await Promise.all([deletePathIgnoringErrors(playlistPath)]);
        throw e;
    } finally {
        await Promise.all([
            deletePathIgnoringErrors(stderrPath),
            deletePathIgnoringErrors(keyInfoPath),
            deletePathIgnoringErrors(keyPath),
            deletePathIgnoringErrors(videoPath),
            // FFmpeg can leave this beside the output after failures.
            deletePathIgnoringErrors(videoPath + ".tmp"),
        ]);
    }

    return {
        playlistPath,
        dimensions,
        videoSize,
        videoObjectID,
        isLosslessCopy,
    };
};

/**
 * Stitch an HLS stream back into a standalone MP4.
 *
 * This is the inverse of {@link ffmpegGenerateHLSPlaylistAndSegments}, and
 * expects the same shape of input that it produces: a playlist whose segments
 * are byte ranges into a single AES-128 encrypted MPEG-TS file sitting next to
 * it.
 *
 * FFmpeg's HLS demuxer already knows how to reassemble and decrypt all that, so
 * the streams themselves are copied across without a re-encode. The result is
 * the same 720p-ish video that would've been streamed, just in a single file
 * that arbitrary players understand.
 *
 * @param playlistFilePath Path to the m3u8 playlist. Both the video it refers
 * to and its key must be resolvable relative to it (in particular, the demuxer
 * will not fetch a key inlined as a "data:" URI, only file and http ones).
 *
 * @param outputFilePath Path to write the resultant MP4 to.
 */
const ffmpegMergeHLSStream = async (
    playlistFilePath: string,
    outputFilePath: string,
): Promise<void> => {
    const command = [
        ffmpegBinaryPath(),
        ["-hide_banner"],
        // Everything the demuxer needs is a local file alongside the playlist.
        ["-protocol_whitelist", "file,crypto"],
        // The demuxer otherwise refuses to open the key, whose extension is not
        // one it recognizes as a multimedia one. We're only pointing it at a
        // playlist we just wrote ourselves, into a directory of our own.
        ["-allowed_extensions", "ALL"],
        ["-i", playlistFilePath],
        // The MP4 muxer adds the aac_adtstoasc bitstream filter itself, so the
        // AAC frames the segments carry need no special handling here.
        ["-c", "copy"],
        // exec provides no stdin, so an overwrite prompt would hang us.
        "-y",
        outputFilePath,
    ].flat();

    await execAsyncWorker(command);
};

// Log sizes at a glance; exactness is the byte counts' job, not this one's.
const formatBytes = (n: number) => {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i == 0 ? v : v.toFixed(1)} ${units[i]}`;
};

const deletePathIgnoringErrors = async (tempFilePath: string) => {
    try {
        await fs.rm(tempFilePath, { force: true });
    } catch (e) {
        log.error(`Could not delete item at path ${tempFilePath}`, e);
    }
};

const videoStreamLineRegex = /Stream #.+: Video:(.+)\r?\n/;

const videoStreamLinesRegex = /Stream #.+: Video:(.+)\r?\n/g;

const audioStreamLinesRegex = /Stream #.+: Audio:(.+)\r?\n/g;

// Anything that is not video or audio: subtitles, data, attachments, timecode.
// FFmpeg's default stream selection drops all of these.
const otherStreamLinesRegex =
    /Stream #.+: (?!Video:|Audio:)(Subtitle|Data|Attachment):/g;

// Rotation lives in the MP4 display matrix, which MPEG-TS cannot carry.
const displayMatrixRegex = /displaymatrix: rotation of/;

// FFmpeg dumps the streams of its own output after one of these lines, and the
// null output we probe with always has a video stream of its own. Only the
// input dump above them describes the file, so the counts come from it alone.
const inputSectionEndRegex = /^(?:Stream mapping:|Output #)/m;

const videoBitrateRegex = / ([1-9]\d*) kb\/s/;

// Leading nonzero digits avoid matching hexadecimal constants in stream info.
const videoDimensionsRegex = / ([1-9]\d*)x([1-9]\d*)/;

interface VideoCharacteristics {
    isH264: boolean;
    isAAC: boolean;
    isHDR: boolean;
    bitrate: number | undefined;
    videoStreamCount: number;
    audioStreamCount: number;
    /**
     * The count of streams that are neither video nor audio, and which the
     * generated stream would therefore silently drop.
     */
    otherStreamCount: number;
    /**
     * If true, the video carries rotation metadata that would not survive a
     * round trip through the MPEG-TS segments.
     */
    hasDisplayMatrix: boolean;
}

// We do not bundle ffprobe, so this parses ffmpeg stderr. Failed parses fall
// back to re-encoding instead of incorrectly skipping conversion.
const detectVideoCharacteristics = async (inputFilePath: string) => {
    const videoInfo = await pseudoFFProbeVideo(inputFilePath);
    const videoStreamLine = videoStreamLineRegex.exec(videoInfo)?.at(1)?.trim();

    const res: VideoCharacteristics = {
        isH264: false,
        isAAC: false,
        isHDR: false,
        bitrate: undefined,
        // A failed parse leaves these at zero, which reads as ineligible for
        // the lossless copy below rather than as a video with no extra streams.
        videoStreamCount: 0,
        audioStreamCount: 0,
        otherStreamCount: 0,
        hasDisplayMatrix: false,
    };

    // A missing sentinel leaves the whole string, which can only overcount and
    // so keeps the original.
    const inputInfo = videoInfo.slice(
        0,
        inputSectionEndRegex.exec(videoInfo)?.index,
    );

    // FFmpeg selects the "best" audio stream, not necessarily the first one,
    // so only claim AAC when every candidate is AAC-LC. Other profiles
    // (HE-AAC, xHE-AAC) are printed as e.g. "aac (HE-AAC)" and are not
    // dependably playable, so they are excluded too.
    const audioStreamLines = Array.from(
        inputInfo.matchAll(audioStreamLinesRegex),
    ).map((m) => m[1]!.trim());
    res.isAAC =
        audioStreamLines.length > 0 &&
        audioStreamLines.every((line) => line.startsWith("aac (LC)"));

    res.audioStreamCount = audioStreamLines.length;
    res.videoStreamCount = Array.from(
        inputInfo.matchAll(videoStreamLinesRegex),
    ).length;
    res.otherStreamCount = Array.from(
        inputInfo.matchAll(otherStreamLinesRegex),
    ).length;
    res.hasDisplayMatrix = displayMatrixRegex.test(inputInfo);

    if (!videoStreamLine) return res;

    res.isH264 = videoStreamLine.startsWith("h264 ");

    res.isHDR =
        videoStreamLine.includes("smpte2084") ||
        videoStreamLine.includes("arib-std-b67");

    const brs = videoBitrateRegex.exec(videoStreamLine)?.at(0);
    if (brs) {
        const br = parseInt(brs, 10);
        if (br) res.bitrate = br * 1000;
    }

    return res;
};

const detectVideoDimensions = async (stderrPath: string) => {
    const conversionStderr = await fs.readFile(stderrPath, "utf-8");

    // Conversion output lists the input stream before the output stream.
    const videoStreamLine = Array.from(
        conversionStderr.matchAll(videoStreamLinesRegex),
    )
        .at(-1)
        ?.at(1);
    if (videoStreamLine) {
        const [, ws, hs] = videoDimensionsRegex.exec(videoStreamLine) ?? [];
        if (ws && hs) {
            const w = parseInt(ws, 10);
            const h = parseInt(hs, 10);
            if (w && h) {
                return { width: w, height: h };
            }
        }
    }
    throw new Error(
        `Unable to detect video dimensions from stream line [${videoStreamLine ?? ""}]`,
    );
};

// False positives fail zscale with "code 3074: no path between colorspaces";
// false negatives only miss tonemapping, so allow-list known HDR transfers.
const isHDRVideo = async (inputFilePath: string) => {
    try {
        const videoInfo = await pseudoFFProbeVideo(inputFilePath);
        const vs = videoStreamLineRegex.exec(videoInfo)?.at(1);
        if (!vs) return false;
        return vs.includes("smpte2084") || vs.includes("arib-std-b67");
    } catch (e) {
        log.warn(`Could not detect HDR status of ${inputFilePath}`, e);
        return false;
    }
};

// Extract stream metadata from ffmpeg stderr because ffprobe is not bundled.
const pseudoFFProbeVideo = async (inputFilePath: string) => {
    const command = [
        ffmpegPathPlaceholder,
        ["-hide_banner"],
        ["-i", inputPathPlaceholder],
        "-an",
        ["-frames:v", "0"],
        ["-f", "null"],
        "-",
    ].flat();

    const cmd = substitutePlaceholders(command, inputFilePath, "");

    const { stderr } = await execAsyncWorker(cmd);

    return stderr;
};

const uploadVideoSegments = async (
    videoFilePath: string,
    videoSize: number,
    fileID: number,
    fetchURL: string,
    authToken: string,
) => {
    // Leave headroom below Cloudflare's 100 MB limit for self-hosters.
    const partSize = 96 * 1024 * 1024;
    const partCount = Math.ceil(videoSize / partSize);

    const { objectID, url, partURLs, completeURL } =
        await getFilePreviewDataUploadURL(
            partCount,
            fileID,
            fetchURL,
            authToken,
        );

    if (url) {
        await uploadVideoSegmentsSingle(videoFilePath, videoSize, url);
    } else if (partURLs && completeURL) {
        await uploadVideoSegmentsMultipart(
            videoFilePath,
            videoSize,
            partSize,
            partURLs,
            completeURL,
        );
    } else {
        throw new Error("Malformed upload URLs");
    }

    return objectID;
};

const FilePreviewDataUploadURLResponse = z.object({
    objectID: z.string(),
    url: z.string().nullish().transform(nullToUndefined),
    partURLs: z.string().array().nullish().transform(nullToUndefined),
    completeURL: z.string().nullish().transform(nullToUndefined),
});

export const getFilePreviewDataUploadURL = async (
    partCount: number,
    fileID: number,
    fetchURL: string,
    authToken: string,
) => {
    const params = new URLSearchParams({
        fileID: fileID.toString(),
        type: "vid_preview",
        ts: Date.now().toString(),
    });
    if (partCount > 1) {
        params.set("isMultiPart", "true");
        params.set("count", partCount.toString());
    }

    const res = await retryEnsuringHTTPOk(() =>
        fetch(`${fetchURL}?${params.toString()}`, {
            headers: authenticatedRequestHeaders(
                desktopAppVersion(),
                authToken,
            ),
        }),
    );

    return FilePreviewDataUploadURLResponse.parse(await res.json());
};

const uploadVideoSegmentsSingle = (
    videoFilePath: string,
    videoSize: number,
    objectUploadURL: string,
) =>
    retryEnsuringHTTPOk(() =>
        // Electron's net.fetch is 40-50x slower for this streaming PUT.
        fetch(objectUploadURL, {
            method: "PUT",
            // Node fetch does not infer Content-Length for streams.
            headers: {
                ...publicRequestHeaders(desktopAppVersion()),
                "Content-Length": `${videoSize}`,
            },
            // @ts-expect-error Node fetch accepts duplex streaming.
            duplex: "half",
            // Node's ReadableStream type does not satisfy DOM BodyInit.
            body: Readable.toWeb(
                fs_.createReadStream(videoFilePath),
            ) as unknown as BodyInit,
        }),
    );

const retryEnsuringHTTPOk = async (request: () => Promise<Response>) => {
    const waitTimeBeforeNextTry = [10000, 30000, 120000];

    while (true) {
        try {
            const res = await request();
            if (res.ok) return res;
            throw new Error(
                `Request failed: HTTP ${res.status} ${res.statusText}`,
            );
        } catch (e) {
            const t = waitTimeBeforeNextTry.shift();
            if (!t) {
                throw e;
            } else {
                log.warn("Will retry potentially transient request failure", e);
                await wait(t);
            }
        }
    }
};

const uploadVideoSegmentsMultipart = async (
    videoFilePath: string,
    videoSize: number,
    partSize: number,
    partUploadURLs: string[],
    completionURL: string,
) => {
    let partNumber = 0;
    let start = 0;
    const completionXML = ["<CompleteMultipartUpload>"];
    for (const partUploadURL of partUploadURLs) {
        partNumber += 1;
        const size = Math.min(start + partSize, videoSize) - start;
        const end = start + size - 1;
        const res = await retryEnsuringHTTPOk(() =>
            fetch(partUploadURL, {
                method: "PUT",
                headers: {
                    ...publicRequestHeaders(desktopAppVersion()),
                    "Content-Length": `${size}`,
                },
                // @ts-expect-error Node fetch accepts duplex streaming.
                duplex: "half",
                // Node's ReadableStream type does not satisfy DOM BodyInit.
                body: Readable.toWeb(
                    fs_.createReadStream(videoFilePath, { start, end }),
                ) as unknown as BodyInit,
            }),
        );
        const eTag = res.headers.get("etag");
        if (!eTag) throw new Error("Response did not have an ETag");
        start += size;
        completionXML.push(
            `<Part><PartNumber>${partNumber}</PartNumber><ETag>${eTag}</ETag></Part>`,
        );
    }
    completionXML.push("</CompleteMultipartUpload>");
    const completionBody = completionXML.join("");
    return await retryEnsuringHTTPOk(() =>
        fetch(completionURL, {
            method: "POST",
            headers: {
                ...publicRequestHeaders(desktopAppVersion()),
                "Content-Type": "text/xml",
            },
            body: completionBody,
        }),
    );
};

const videoDurationLineRegex = /\s\sDuration: ([0-9:]+)(.[0-9]+)?/;

export const ffmpegDetermineVideoDuration = async (inputFilePath: string) => {
    const videoInfo = await pseudoFFProbeVideo(inputFilePath);
    const matches = videoDurationLineRegex.exec(videoInfo);

    const fail = () => {
        throw new Error(`Cannot parse video duration '${matches?.at(0)}'`);
    };

    const ints = (matches?.at(1) ?? "")
        .split(":")
        .map((s) => parseInt(s, 10) || 0);
    let [h, m, s] = [0, 0, 0];
    switch (ints.length) {
        case 1:
            s = ints[0]!;
            break;
        case 2:
            m = ints[0]!;
            s = ints[1]!;
            break;
        case 3:
            h = ints[0]!;
            m = ints[1]!;
            s = ints[2]!;
            break;
        default:
            fail();
    }

    const ss = parseFloat(`0${matches?.at(2) ?? ""}`);

    // Match the web implementation's rounding.
    const duration = Math.ceil(h * 3600 + m * 60 + s + ss);
    if (!duration) fail();
    return duration;
};
