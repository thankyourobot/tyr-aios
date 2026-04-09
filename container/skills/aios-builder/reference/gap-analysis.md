# Gap Analysis

How a director agent maps its domain and stays oriented toward excellence over time.

## What It Is

A gap analysis is a director agent's map of what a high-functioning version of its domain looks like — and where current reality falls short. It answers the question: *if this function were operating at full effectiveness, what would that actually look like?*

Without this map, an agent can only respond to what it's asked. With it, the agent knows what it should be doing even when no one is asking. This is the difference between a reactive tool and a proactive team member.

## Who Needs It

Director agents — those whose directive includes improving a function over time, not just executing within it. If the agent is responsible for making the function better, it needs a map of what "better" means.

Technician agents don't run gap analyses. Their function has been defined by a director. Their job is to execute well within that definition, not to redesign it.

## The Artifact

The gap analysis lives in `projects/gap-analysis/` within the agent's workspace. At the root is `domain-model.md` — a register of the domain's sub-functions, the current state of each, what excellent looks like, and where the gaps are. This is the map.

Sub-function context lives in subdirectories — deeper playbooks, procedures, research, and context for each area. The domain model routes to these; it doesn't contain them.

This is a perpetual project. It doesn't close. It evolves as the domain matures and the agent learns.

## Building a V1

The agent first assesses what organizational context is available — the prime directive, org vision, industry, stage of business, any prior work in the workspace. If there's enough to reason from, the agent starts building. If not, it asks targeted questions before researching.

A v1 gap analysis is built primarily through domain research — what does excellent look like in this function? What sub-functions are typically required? What does evidence say matters most at this stage of business? The web is a primary resource here.

The v1 is then brought to the chain of command for feedback and iteration. It's easier to react to something that exists than to imagine it from scratch — the goal is a working starting point, not a perfect artifact. The agent iterates from feedback until the map is good enough to act on.

Start simple. A gap analysis that works will be simpler than the ideal one you might imagine. Earn complexity as the domain matures and the gaps become clearer.

## The Loops

A gap analysis isn't a one-time deliverable. Three loops keep it alive and useful.

**Domain research** gathers new information about the domain on a recurring cadence — what practitioners are doing, what's emerging, what's working. This is the outward signal: what does the world know about this function that the agent should incorporate? The cadence is domain-specific. Fast-moving domains (growth, product) warrant more frequent research than slower-moving ones.

When researching, bias toward AI-native approaches — not just how human teams have traditionally structured this function, but how an AI-native organization might do it differently. AI agents are technicians: they execute consistently, scale without friction, run continuously. Humans are orchestrators: they provide judgment, taste, real-world access, and verification. A high-functioning AI-native domain is designed around this division — not just automating what humans used to do, but rethinking what the function looks like when execution is cheap and judgment is the scarce resource.

**Execution signal** tracks how the current sub-functions are actually performing. What's working, what isn't, what gaps have closed, what new ones have emerged. This is the inward signal: how does current reality compare to the map?

**Meta-loop synthesis** periodically combines both signals and asks: should anything change in the map itself? New information becomes a potential revision to what "good" looks like. This is slower and more deliberate than the research loop — not every data point justifies changing direction. Revisions to the gap analysis represent changes in theory and should be driven by patterns, not individual observations.

The meta-loop also reviews the loops themselves — not just the map. Are the cadences still calibrated to the domain? Is domain research actually running and returning useful signal? Is execution signal capturing what actually matters? If the loops are off, the map drifts regardless of how good the synthesis is.

Meta-loop cadence scales with maturity. Early-stage: the map is rough and revision should be frequent. Mature: revision happens on meaningful triggers — a consistent pattern in research, a sub-function persistently underperforming, a significant external shift in the domain.

## Gaps as Tasks and Jobs

The gap analysis has no value if it doesn't change what the agent does. Every meaningful gap should translate to work — tracked in `tasks.db` (one-off) or `scheduled_jobs` (recurring) and driven to completion through the standard heartbeat loop.

Two types of work emerge from a gap analysis:

**One-off tasks** close a specific gap — build this process, configure this integration, deliver this artifact. Create them in `tasks.db` with enough context to act on. The heartbeat picks them up.

**Recurring jobs** address gaps that require ongoing attention — a domain research cadence, a monitoring check, a periodic review. These become scheduled jobs via the `schedule_job` MCP tool.

All three loops are recurring jobs. Schedule them. A loop that only runs when someone thinks to do it isn't a loop — it's an intention. Domain research and execution signal cadence scales with domain velocity — fast-moving functions (growth, product) warrant higher frequency; stable functions can run slower. Meta-loop cadence scales with maturity — earlier stages revisit the map more often; mature domains wait for meaningful triggers.

A gap analysis that isn't generating tasks isn't working. If the map is growing but the task queue isn't moving, the map has become overhead.

## Gall's Law

Complex systems that work evolved from simple systems that worked. The gap analysis is no exception.

A v1 should cover the obvious sub-functions and no more. An over-specified map produces too many open gaps to act on, creates a false sense of completeness, and is hard to update. The meta-loop is where complexity gets earned — each revision is an opportunity to ask whether more specificity is actually needed, or whether it's just making things prettier.

The gap analysis is a tool for action, not a planning artifact. If it's generating insight that drives work, it's working. If it's growing elaborate but not changing what the agent does, it's become overhead.

## Going Deeper: Logic Models

As sub-functions mature, a logic model becomes a useful next layer. Where the gap analysis maps *what* a domain needs to produce, a logic model maps *how* a specific sub-function produces it — tracing resources and activities through outputs to short, mid, and long-term outcomes.

Logic models aren't for v1. Apply them when a sub-function is stable enough that the question shifts from "should this exist?" to "is this working as intended?" See `reference/logic-model.md`.

## Relationship to Onboarding

For director agents, the gap analysis is part of onboarding — not an optional follow-on. Access decisions (what tools does this function actually need?) and rhythm decisions (what cadences does this domain warrant?) are better made after the map exists.

The v1 built during onboarding doesn't need to be complete. It needs to be good enough to act on. The loops take it from there.

Before closing onboarding, the agent should write a brief operational note in `projects/gap-analysis/` — summarizing how its loops will run, what cadences are scheduled, and what to check first in future sessions. This note is for the agent's future self, not for documentation's sake. Future sessions won't re-read this reference file; they'll read the workspace.
