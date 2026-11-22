import { slugify } from "./util";
import { parseRepositoryVersionMessage } from "./validation";

type RepositoryCreationInput = {
  message?: string;
  name?: string;
  title?: string;
};

function repositoryMetadata(input: RepositoryCreationInput) {
  const title = input.title?.trim() || "Untitled printer";
  const name = slugify(input.name ?? title);
  return name ? { name, title } : null;
}

export function createEmptyRepositoryCreationPlan({
  input,
  repoId,
  timestamp,
  userId,
}: Omit<CreateRepositoryCreationPlanInput, "versionId">) {
  const metadata = repositoryMetadata(input);
  if (!metadata) {
    return null;
  }

  const repositoryInsert = {
    created_at: timestamp,
    id: repoId,
    latest_version_id: null,
    name: metadata.name,
    title: metadata.title,
    updated_at: timestamp,
    user_id: userId,
  };

  return {
    repositoryInsert,
    response: {
      repository: repositoryInsert,
      version: null,
    },
  };
}

type CreateRepositoryCreationPlanInput = {
  input: RepositoryCreationInput;
  repoId: string;
  timestamp: string;
  userId: string;
  versionId: string;
};

export function createRepositoryCreationPlan({
  input,
  repoId,
  timestamp,
  userId,
  versionId,
}: CreateRepositoryCreationPlanInput) {
  const metadata = repositoryMetadata(input);
  if (!metadata) {
    return null;
  }

  const parsedMessage = parseRepositoryVersionMessage(input.message);
  if (!parsedMessage.ok) {
    return null;
  }
  const message = parsedMessage.value || "Initial version";

  return {
    repositoryInsert: {
      created_at: timestamp,
      id: repoId,
      latest_version_id: versionId,
      name: metadata.name,
      title: metadata.title,
      updated_at: timestamp,
      user_id: userId,
    },
    response: {
      repository: {
        created_at: timestamp,
        id: repoId,
        latest_version_id: versionId,
        name: metadata.name,
        title: metadata.title,
        updated_at: timestamp,
      },
      version: {
        created_at: timestamp,
        id: versionId,
        message,
        previous_version_id: null,
        source: "web-editor",
        version_number: 1,
      },
    },
    versionInsert: {
      created_at: timestamp,
      id: versionId,
      message,
      previous_version_id: null,
      repository_id: repoId,
      source: "web-editor",
      version_number: 1,
    },
  };
}
