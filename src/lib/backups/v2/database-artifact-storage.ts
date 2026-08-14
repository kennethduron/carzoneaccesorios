import "server-only";

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  databaseArtifactFilename,
  databaseArtifactId,
  requireCanonicalGenerationKey,
} from "./database-artifact-format.ts";
import { BackupV2FailClosedError } from "./types.ts";

export interface DatabaseArtifactPaths {
  workspaceRoot: string;
  artifactId: string;
  finalDirectory: string;
  artifactPath: string;
  manifestPath: string;
}

export interface PartialDatabaseArtifactPaths extends DatabaseArtifactPaths {
  partialDirectory: string;
  partialArtifactPath: string;
  partialManifestPath: string;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function assertDirectChild(root: string, candidate: string, expectedPrefix?: string): void {
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== root || (expectedPrefix && !path.basename(resolved).startsWith(expectedPrefix))) {
    fail("BACKUP_V2_PATH_ESCAPE", "Artifact path escaped the controlled workspace");
  }
}

async function controlledWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0 || workspaceRoot.includes("\0")) {
    fail("BACKUP_V2_INVALID_WORKSPACE", "Artifact workspace is invalid");
  }
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(workspaceRoot);
  const stat = await lstat(root);
  if (!stat.isDirectory()) fail("BACKUP_V2_INVALID_WORKSPACE", "Artifact workspace is not a directory");
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}

export async function resolveDatabaseArtifactPaths(
  workspaceRootValue: string,
  generationKeyValue: string,
): Promise<DatabaseArtifactPaths> {
  const generationKey = requireCanonicalGenerationKey(generationKeyValue);
  const workspaceRoot = await controlledWorkspaceRoot(workspaceRootValue);
  const artifactId = databaseArtifactId(generationKey);
  const finalDirectory = path.resolve(workspaceRoot, artifactId);
  assertDirectChild(workspaceRoot, finalDirectory);
  return {
    workspaceRoot,
    artifactId,
    finalDirectory,
    artifactPath: path.join(finalDirectory, databaseArtifactFilename(artifactId)),
    manifestPath: path.join(finalDirectory, `${artifactId}.manifest.json`),
  };
}

export async function finalDatabaseArtifactExists(paths: DatabaseArtifactPaths): Promise<boolean> {
  try {
    const stat = await lstat(paths.finalDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("BACKUP_V2_UNSAFE_FINAL_ARTIFACT_PATH", "Final artifact path is not a regular directory");
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function createPartialDatabaseArtifactPaths(
  paths: DatabaseArtifactPaths,
): Promise<PartialDatabaseArtifactPaths> {
  const partialName = `.partial-${paths.artifactId}-${randomUUID()}`;
  const partialDirectory = path.resolve(paths.workspaceRoot, partialName);
  assertDirectChild(paths.workspaceRoot, partialDirectory, `.partial-${paths.artifactId}-`);
  await mkdir(partialDirectory, { recursive: false, mode: 0o700 });
  const partialRealPath = await realpath(partialDirectory);
  if (partialRealPath !== partialDirectory) {
    fail("BACKUP_V2_UNSAFE_TEMP_ARTIFACT_PATH", "Partial artifact directory resolved unexpectedly");
  }
  return {
    ...paths,
    partialDirectory,
    partialArtifactPath: path.join(partialDirectory, databaseArtifactFilename(paths.artifactId)),
    partialManifestPath: path.join(partialDirectory, `${paths.artifactId}.manifest.json`),
  };
}

export async function hardenArtifactFile(filePath: string): Promise<void> {
  await chmod(filePath, 0o600).catch(() => undefined);
}

export async function publishPartialDatabaseArtifact(paths: PartialDatabaseArtifactPaths): Promise<void> {
  assertDirectChild(paths.workspaceRoot, paths.partialDirectory, `.partial-${paths.artifactId}-`);
  assertDirectChild(paths.workspaceRoot, paths.finalDirectory);
  try {
    await rename(paths.partialDirectory, paths.finalDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error &&
        ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))) {
      fail("BACKUP_V2_CANONICAL_ARTIFACT_CONFLICT", "A canonical database artifact already exists");
    }
    throw error;
  }
}

export async function cleanupPartialDatabaseArtifact(paths: PartialDatabaseArtifactPaths): Promise<void> {
  const resolved = path.resolve(paths.partialDirectory);
  assertDirectChild(paths.workspaceRoot, resolved, `.partial-${paths.artifactId}-`);
  await rm(resolved, { recursive: true, force: true });
}
