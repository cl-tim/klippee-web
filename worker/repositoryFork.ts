import type { ConfigFile } from "../src/types";
import { slugify } from "./util";

type ForkInput = {
  name?: string;
  title?: string;
};

type ForkSourceRepository = {
  name: string;
  title: string;
};

type CreateRepositoryForkPlanInput = {
  files: ConfigFile[];
  input: ForkInput;
  repo: ForkSourceRepository;
  repoId: string;
  suffix: string;
  timestamp: string;
  userId: string;
  versionId: string;
  versionNumber: number;
};

export function createRepositoryForkPlan({
  files,
  input,
  repo,
  repoId,
  suffix,
  timestamp,
  userId,
  versionId,
  versionNumber,
}: CreateRepositoryForkPlanInput) {
  const title = input.title?.trim() || `${repo.title} fork`;
  const name = `${slugify(input.name ?? title) || "fork"}-${suffix}`;
  const message = `Fork from ${repo.name} version ${versionNumber}`;

  return {
    repositoryInsert: {
      created_at: timestamp,
      id: repoId,
      latest_version_id: versionId,
      name,
      title,
      updated_at: timestamp,
      user_id: userId,
    },
    response: {
      repository: {
        created_at: timestamp,
        id: repoId,
        latest_version_id: versionId,
        name,
        title,
        updated_at: timestamp,
      },
      version: {
        created_at: timestamp,
        files,
        id: versionId,
        message,
        previous_version_id: null,
        source: "fork",
        version_number: 1,
      },
    },
    versionInsert: {
      created_at: timestamp,
      id: versionId,
      message,
      previous_version_id: null,
      repository_id: repoId,
      source: "fork",
      version_number: 1,
    },
  };
}
