import { appendFileSync, readFileSync } from "node:fs"

const prepareStatus = process.env.PREPARE_STATUS ?? ""
const prepareReason = process.env.PREPARE_REASON ?? ""
const upstream = process.env.UPSTREAM_SHA ?? ""
const event = process.env.GITHUB_EVENT_NAME ?? ""
const issue = Number(process.env.COWORKERS_UPDATE_ISSUE_NUMBER)
const outputPath = process.env.GITHUB_OUTPUT

function output(status, reason = "") {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required")
  appendFileSync(
    outputPath,
    [`status=${status}`, `reason=${reason.replace(/\n/g, " ")}`, ""].join("\n")
  )
  console.log(JSON.stringify({ status, reason }))
}

if (prepareStatus === "no-update" || prepareStatus === "") {
  output(prepareStatus, prepareReason)
  process.exit(0)
}
if (event !== "schedule") {
  output(prepareStatus, "manual run bypasses failed-candidate suppression")
  process.exit(0)
}
if (!/^[0-9a-f]{40}$/.test(upstream)) {
  throw new Error("UPSTREAM_SHA must be a full commit SHA")
}
if (!Number.isInteger(issue) || issue <= 0) {
  throw new Error("COWORKERS_UPDATE_ISSUE_NUMBER must be a positive integer")
}

async function readComments() {
  if (process.env.FAILURE_COMMENTS_FILE) {
    const value = JSON.parse(
      readFileSync(process.env.FAILURE_COMMENTS_FILE, "utf8")
    )
    if (!Array.isArray(value))
      throw new Error("failure comments fixture must be an array")
    return value
  }

  const token = process.env.GH_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  if (!token || !repository) {
    throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required")
  }

  const comments = []
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com"
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${api}/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!response.ok) {
      throw new Error(`GitHub comments request failed: ${response.status}`)
    }
    const pageComments = await response.json()
    if (!Array.isArray(pageComments)) {
      throw new Error("GitHub comments response was not an array")
    }
    comments.push(...pageComments)
    if (pageComments.length < 100) return comments
  }
}

const marker = `<!-- coworkers-upstream-failure:${upstream} -->`
const comments = await readComments()
const blocked = comments.some((comment) =>
  String(comment.body ?? "").includes(marker)
)
if (blocked) {
  output(
    "failed-candidate-suppressed",
    `upstream ${upstream} previously failed; manually dispatch the sync workflow to retry`
  )
} else {
  output(prepareStatus, "no persistent failure marker")
}
