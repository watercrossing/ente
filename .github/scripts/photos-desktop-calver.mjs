#!/usr/bin/env node

// This fork's CalVer line for the Photos desktop builds, and the rule that
// keeps a local build from colliding with one CI publishes.
//
// Run directly, it prints the version a local build should carry today:
//
//     node .github/scripts/photos-desktop-calver.mjs   # e.g. 2026.817.0
//
// Pass that to electron-builder as --config.extraMetadata.version=<version>
// rather than writing it into desktop/package.json, which is upstream's file:
// electron-builder merges extraMetadata into the app metadata before it reads
// the version, so the installer name, latest.yml and app.getVersion() all pick
// it up while the worktree stays clean.
//
// Why builds carry this instead of upstream's number at all: electron-updater
// derives allowPrerelease from the app's own version, and upstream's
// "<next>-beta" turns it on, which sends GitHubProvider down a branch that
// skips every release whose tag is not valid semver — ours are all
// wc-photos-desktop-v*. A build stamped with upstream's version can therefore
// never update itself from this fork's releases.

import path from "node:path";
import { fileURLToPath } from "node:url";

// The build number CI starts from. It counts releases published on the day, so
// the first CI build of any day is 1 and a local build can safely take 0.
const firstCIBuildNumber = 1;

/**
 * The CalVer base for a date, matching the workflow's `date -u +%Y.%-m%d`.
 *
 * The month is unpadded because semver rejects leading zeros in a numeric
 * component. Ordering still holds: 2026.101.1 < 2026.816.1 < 2026.1231.1.
 */
export function calverBase(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${year}.${month}${day}`;
}

/** The version a local build made on {@link now} should carry. */
export function localVersion(now = new Date()) {
    return `${calverBase(now)}.${firstCIBuildNumber - 1}`;
}

/**
 * Throw if `version` is one only CI may issue.
 *
 * Local builds take build number 0, which sorts below every CI build of the
 * same day, so the next release supersedes the local install. Reusing a CI
 * number instead would put a different binary under a published version, and
 * electron-updater compares versions alone — it reads the two as the same
 * build and never offers the real one.
 *
 * Versions carrying upstream's -beta suffix are left alone: they are not ours
 * to number.
 */
export function assertLocalBuildNumber(version) {
    if (process.env.CI) return;
    if (version.endsWith("-beta")) return;
    const buildNumber = version.split(".")[2];
    if (buildNumber !== "0") {
        throw new Error(
            `Refusing to set ${version} outside CI: local builds take build number 0, e.g. ${localVersion()}. ` +
                `CI numbers from the tags it has published, starting at ${firstCIBuildNumber}, and a local binary ` +
                `stamped with a released version is one electron-updater compares as equal to it, so the machine ` +
                `would never update to the real release.`,
        );
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) console.log(localVersion());
