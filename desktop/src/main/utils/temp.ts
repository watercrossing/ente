import { app } from "electron/main";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ZipItem } from "../../types/ipc";
import log from "../log";
import { markClosableZip, openZip } from "../services/zip";
import { writeStream } from "./stream";

const enteTempDirPath = async () => {
    const result = path.join(app.getPath("temp"), "ente");
    await fs.mkdir(result, { recursive: true });
    return result;
};

const randomPrefix = () => {
    const ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomChar = () => ch[Math.floor(Math.random() * ch.length)]!;

    return Array(10).fill("").map(randomChar).join("");
};

export const makeTempFilePath = async (extension?: string) => {
    const tempDir = await enteTempDirPath();
    const suffix = extension ? "." + extension : "";
    let result: string;
    do {
        result = path.join(tempDir, randomPrefix() + suffix);
    } while (existsSync(result));
    return result;
};

export const deleteTempFile = async (tempFilePath: string) => {
    const tempDir = await enteTempDirPath();
    if (!tempFilePath.startsWith(tempDir))
        throw new Error(`Attempting to delete a non-temp file ${tempFilePath}`);
    await fs.rm(tempFilePath, { force: true });
};

export const deleteTempFileIgnoringErrors = async (tempFilePath: string) => {
    try {
        await deleteTempFile(tempFilePath);
    } catch (e) {
        log.error(`Could not delete temporary file at path ${tempFilePath}`, e);
    }
};

/**
 * Variant of {@link deleteTempFileIgnoringErrors} for a temporary directory,
 * deleting it along with everything within it.
 */
export const deleteTempDirIgnoringErrors = async (tempDirPath: string) => {
    try {
        const tempDir = await enteTempDirPath();
        if (!tempDirPath.startsWith(tempDir))
            throw new Error(
                `Attempting to delete a non-temp directory ${tempDirPath}`,
            );
        await fs.rm(tempDirPath, { recursive: true, force: true });
    } catch (e) {
        log.error(
            `Could not delete temporary directory at path ${tempDirPath}`,
            e,
        );
    }
};

interface FileForStreamOrPathOrZipItem {
    path: string;
    isFileTemporary: boolean;
    writeToTemporaryFile: () => Promise<void>;
}

export const makeFileForStreamOrPathOrZipItem = async (
    item: ReadableStream | string | ZipItem,
): Promise<FileForStreamOrPathOrZipItem> => {
    let path: string;
    let isFileTemporary: boolean;
    let writeToTemporaryFile = async () => {
        /* no-op */
    };

    if (typeof item == "string") {
        path = item;
        isFileTemporary = false;
    } else {
        path = await makeTempFilePath();
        isFileTemporary = true;
        if (item instanceof ReadableStream) {
            writeToTemporaryFile = () => writeStream(path, item);
        } else {
            writeToTemporaryFile = async () => {
                const [zipPath, entryName] = item;
                const zip = openZip(zipPath);
                try {
                    await zip.extract(entryName, path);
                } finally {
                    markClosableZip(zipPath);
                }
            };
        }
    }

    return { path, isFileTemporary, writeToTemporaryFile };
};
