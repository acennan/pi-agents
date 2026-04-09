import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { sharedPromptTemplatesDir } from "../storage/team-home.ts";

export class TeamPromptTemplateError extends Error {
  readonly code:
    | "invalid-template-args"
    | "invalid-template-name"
    | "template-load-failed";

  constructor(
    code: TeamPromptTemplateError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamPromptTemplateError";
    this.code = code;
  }
}

export async function renderSharedPromptTemplate(options: {
  templateFileName: string;
  args: readonly string[];
  templatesDir?: string;
}): Promise<string> {
  const templatesDir = options.templatesDir ?? sharedPromptTemplatesDir();
  const templatePath = resolveTemplatePath(
    options.templateFileName,
    templatesDir,
  );

  let content: string;
  try {
    content = await readFile(templatePath, "utf8");
  } catch (error: unknown) {
    throw new TeamPromptTemplateError(
      "template-load-failed",
      `Failed to read prompt template "${options.templateFileName}" from "${templatesDir}"`,
      { cause: error },
    );
  }

  return substituteTemplateArgs(stripFrontmatter(content), options.args);
}

export function serializePromptTemplateArgs(args: readonly string[]): string {
  return JSON.stringify([...args]);
}

export function parsePromptTemplateArgs(serialized: string): string[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    throw new TeamPromptTemplateError(
      "invalid-template-args",
      "Prompt template arguments were not valid JSON",
      { cause: error },
    );
  }

  if (
    !Array.isArray(parsedValue) ||
    parsedValue.some((entry) => typeof entry !== "string")
  ) {
    throw new TeamPromptTemplateError(
      "invalid-template-args",
      "Prompt template arguments must be a JSON array of strings",
    );
  }

  return [...parsedValue];
}

export function formatPromptTemplateFileList(files: readonly string[]): string {
  return files.length === 0
    ? "- none"
    : files.map((file) => `- ${file}`).join("\n");
}

function resolveTemplatePath(
  templateFileName: string,
  templatesDir: string,
): string {
  const trimmed = templateFileName.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== templateFileName ||
    basename(trimmed) !== trimmed ||
    !trimmed.endsWith(".md")
  ) {
    throw new TeamPromptTemplateError(
      "invalid-template-name",
      `Prompt template name "${templateFileName}" must be a bare .md filename`,
    );
  }

  const resolvedDir = resolve(templatesDir);
  const resolvedPath = resolve(resolvedDir, trimmed);
  const prefix = resolvedDir.endsWith(sep)
    ? resolvedDir
    : `${resolvedDir}${sep}`;

  if (!resolvedPath.startsWith(prefix)) {
    throw new TeamPromptTemplateError(
      "invalid-template-name",
      `Prompt template name "${templateFileName}" resolves outside "${resolvedDir}"`,
    );
  }

  return resolvedPath;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function substituteTemplateArgs(
  content: string,
  args: readonly string[],
): string {
  let result = content;

  result = result.replace(/\$(\d+)/g, (_match, numberText: string) => {
    const index = Number.parseInt(numberText, 10) - 1;
    return args[index] ?? "";
  });

  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_match, startText: string, lengthText: string | undefined) => {
      let start = Number.parseInt(startText, 10) - 1;
      if (start < 0) {
        start = 0;
      }

      if (lengthText !== undefined) {
        const length = Number.parseInt(lengthText, 10);
        return args.slice(start, start + length).join(" ");
      }

      return args.slice(start).join(" ");
    },
  );

  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);

  return result;
}
