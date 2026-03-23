---
name: file-sharing
description: "Share files from the agent workspace via clickable FileBrowser links. Use when delivering artifacts, reports, specs, or any file the user should review or download. Produces URLs pointing to files.thankyourobot.ai."
---

# File Sharing Skill

Share files from the agent workspace via FileBrowser links that users can click in Slack.

## FileBrowser

FileBrowser Quantum is a web-based file browser running at `https://files.thankyourobot.ai`. Users can browse, view rendered markdown (with table of contents and syntax highlighting), and download files.

## How to Share a File Link

Construct the URL as:

```
https://files.thankyourobot.ai/files/Agent%20Workspaces/{path-relative-to-groups-dir}
```

**Examples:**
- A file at `/workspace/group/projects/report.md` for group `museminded`:
  `https://files.thankyourobot.ai/files/Agent%20Workspaces/museminded/projects/report.md`
- A file at `/workspace/group/projects/deliverable.pdf` for group `growth`:
  `https://files.thankyourobot.ai/files/Agent%20Workspaces/growth/projects/deliverable.pdf`

The group folder name is the directory name of your workspace. If your workspace is mounted at `/workspace/group/`, the group name is already known from your context.

## When to Share Links

- After producing a new artifact (report, spec, analysis)
- When referencing a file the user should review
- When delivering project work

Post the link directly in your Slack message. It is clickable and opens in the user's browser (login required if not already authenticated).

## Notes

- Links require the user to be logged into FileBrowser (they will see a login page if not authenticated)
- Markdown files render with formatted preview, table of contents, and syntax highlighting
- Spaces in source names must be URL-encoded (`Agent%20Workspaces`)
