// SPDX-License-Identifier: Apache-2.0
/**
 * Structural checks for `to-do.json`.
 *
 * The rules mirror `to-do.schema.json` plus two semantic rules the schema
 * does not state: task identifiers are unique, and `depends_on` names an
 * existing task. Edit this file and the schema together.
 */

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Confirms that the day exists in its stated month. */
function isRealDate(year: number, month: number, day: number): boolean {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const length = lengths[month - 1];
  return length !== undefined && day >= 1 && day <= length;
}

const STATUSES = new Set(["todo", "doing", "blocked", "done"]);

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: Json): value is string {
  return typeof value === "string";
}

function isStringArray(value: Json): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function checkDateTime(field: string, value: Json, errors: string[]): void {
  const match = isString(value) ? DATE_TIME.exec(value) : null;
  if (match === null) {
    errors.push(`${field} is not an ISO 8601 date and time with a zone`);
    return;
  }
  // A JavaScript date parser accepts impossible dates, such as 30 February,
  // by rolling them over. Check the stated day against its month instead.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealDate(year, month, day)) {
    errors.push(`${field} names a day that does not exist`);
  }
}

function checkUnknownFields(
  field: string,
  value: Record<string, Json>,
  known: Set<string>,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      errors.push(`${field}.${key} is not part of the schema`);
    }
  }
}

function checkTask(index: number, task: Json, errors: string[]): void {
  const field = `tasks[${index}]`;
  if (!isObject(task)) {
    errors.push(`${field} is not an object`);
    return;
  }
  const known = new Set([
    "id",
    "title",
    "priority",
    "status",
    "details",
    "steps",
    "blockers",
    "tags",
    "files",
    "depends_on",
    "created_at",
    "updated_at",
  ]);
  checkUnknownFields(field, task, known, errors);

  if (!isString(task.id) || task.id.length === 0) {
    errors.push(`${field}.id is not a nonempty string`);
  }
  if (!isString(task.title) || task.title.length === 0) {
    errors.push(`${field}.title is not a nonempty string`);
  }
  if (
    typeof task.priority !== "number" ||
    !Number.isInteger(task.priority) ||
    task.priority < 1 ||
    task.priority > 5
  ) {
    errors.push(`${field}.priority is not a whole number from 1 to 5`);
  }
  if (!isString(task.status) || !STATUSES.has(task.status)) {
    errors.push(
      `${field}.status is not one of ${[...STATUSES].join(", ")}`,
    );
  }
  for (const listField of ["steps", "blockers", "tags", "files", "depends_on"]) {
    const value = task[listField];
    if (value !== undefined && !isStringArray(value)) {
      errors.push(`${field}.${listField} is not an array of strings`);
    }
  }
  if (task.details !== undefined && !isString(task.details)) {
    errors.push(`${field}.details is not a string`);
  }
  for (const dateField of ["created_at", "updated_at"]) {
    if (task[dateField] !== undefined) {
      checkDateTime(`${field}.${dateField}`, task[dateField], errors);
    }
  }
}

/**
 * Validates a parsed `to-do.json` document and returns every problem found.
 * An empty result means the document is valid.
 */
export function validateTodo(document: Json): string[] {
  const errors: string[] = [];
  if (!isObject(document)) {
    return ["the document is not an object"];
  }
  checkUnknownFields("document", document, new Set(["schema_version", "project", "source_files", "tasks"]), errors);

  if (document.schema_version !== 1) {
    errors.push("schema_version is not 1");
  }
  if (document.project !== undefined) {
    if (!isObject(document.project)) {
      errors.push("project is not an object");
    } else {
      checkUnknownFields("project", document.project, new Set(["name", "root"]), errors);
      if (!isString(document.project.name)) {
        errors.push("project.name is not a string");
      }
      if (!isString(document.project.root)) {
        errors.push("project.root is not a string");
      }
    }
  }
  if (!isStringArray(document.source_files)) {
    errors.push("source_files is not an array of strings");
  }
  if (!Array.isArray(document.tasks)) {
    errors.push("tasks is not an array");
    return errors;
  }
  document.tasks.forEach((task, index) => checkTask(index, task, errors));

  // Semantic rules beyond the schema file.
  const ids = new Set<string>();
  for (const [index, task] of document.tasks.entries()) {
    if (isObject(task) && isString(task.id)) {
      if (ids.has(task.id)) {
        errors.push(`tasks[${index}].id ${JSON.stringify(task.id)} is used more than once`);
      }
      ids.add(task.id);
    }
  }
  for (const [index, task] of document.tasks.entries()) {
    if (!isObject(task) || !isStringArray(task.depends_on)) {
      continue;
    }
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) {
        errors.push(`tasks[${index}].depends_on names the missing task ${JSON.stringify(dependency)}`);
      }
    }
  }
  return errors;
}
