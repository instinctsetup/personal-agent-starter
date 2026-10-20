/**
 * LLM intent router: the user's plain English (typos, Hinglish, whatever) goes
 * to the model race, which maps it onto the canonical command grammar the
 * classic executor already understands - so every approval gate, tracker write
 * and safety stop keeps working exactly as tested. Regex routing stays as the
 * offline fallback when no model is connected.
 */

export interface RouteCommands { kind: "commands"; commands: string[] }
export interface RouteClarify { kind: "clarify"; question: string }
export interface RouteChat { kind: "chat" }
export type Route = RouteCommands | RouteClarify | RouteChat;

/** The canonical grammar the executor understands (mirrors the help text; keep in sync). */
export const COMMAND_GRAMMAR = `
- send mail to <address>: <body text>  OR  send mail to <address> asking for <thing>   (draft card, user taps Send)
- inbox | check mail   (list recent mail)
- mail search <query>   (find and read mail by sender/subject/content: "what does the 2step mail say", "any reply from Priya", "summarize the Google mail")
- latest mail
- hunt <search query>   (job search -> numbered shortlist)
- apply to <job-url>   (one application, approval before anything submits)
- apply to 1,3 | apply all   (picks from the last hunt shortlist)
- track <Company> - <role>
- applications
- open <url>   (drive the live browser)
- sign up on <site> with google
- every <N> minutes|hours <command>   (recurring schedule)
- at <HH:MM> <command>   (one-time schedule)
- jobs   (list scheduled jobs)
- linkedin on | linkedin off | linkedin feed
- linkedin message <profile-url>: <text>
- connect with <profile-url> on linkedin
- connect <service>   (gemini, groq, openrouter, cerebras, github models, email, drive, telegram, profile, github...)
- gemini-web on | gemini-web off
- vault | drive
- upload <path> to drive [as doc] | sync <dir> to drive
- git init <name> | commit <path> [msg] | push <path> | create github repo <name> | git status <path>
- plan <goal>   (durable multi-step plan: checkpointed, retried, resumable - use for "do X then Y then Z" goals)
- plans | resume plan <id> | cancel plan <id>
- caps | cap <action> <N>   (daily limits)
- remember <fact> | memories | forget <id>   (durable memory)
- local | local setup | local on | local off   (on-device models via Ollama)
- skills   (list every tool with its risk tier, caps and approval gates)
- traces | trace <run-id>   (structured run logs as a span tree)
- laptop status | system info   (his laptop's battery, RAM, disk free, CPU - "how's my laptop doing", "battery level")
- what's on my clipboard | copy <text>   (read or set the clipboard)
- open <app>   (launch a program on his laptop: notepad, calculator, paint... - "open notepad")
- note: <text> | notes   (quick timestamped notes)
- remind me at 5pm to <text> | remind me in 30 minutes to <text>   (one-shot reminders)
- quota   (today's free-tier model usage per provider - "usage", "api usage")
- linkedin crm | linkedin follow ups | mark <name> replied   (his LinkedIn outreach pipeline and follow-up nudges)
- what needs a reply   (inbox triage: the few mails actually waiting on him)
- watch <folder> | watched folders | stop watching <folder>   (folder watcher with undo)
- clean up downloads | undo file cleanup   (safe file organizer with an undo ledger)
- every morning <command> | routines | delete routine <name>   (named routines)
- read text in <image-path>   (OCR: text from a screenshot or scan)
- version   (which build of the app is running)
- board <pipeline|inbox|overview>   (live shareable dashboard link)
- boards   (list dashboard links)
- unshare <pipeline|inbox|overview>   (kill the share link, mint a new one)
- help
`.trim();

import type { ChatMessage } from "../src/providers/types.js";

export function routerPrompt(userText: string, memory = ""): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the intent router of a personal assistant app. Map the user's message onto canonical commands from this exact grammar:",
        "",
        COMMAND_GRAMMAR,
        "",
        "Reply with STRICT JSON, one of:",
        '{"commands": ["<canonical command>", ...]}  - one or more commands, executed in order as a plan',
        '{"clarify": "<one short question>"}  - when a required detail is missing (e.g. no email address, no job URL, which account)',
        '{"chat": true}  - general conversation, not an action. NEVER chat for questions about the user\'s own mail, files, applications, schedule, laptop/system status, clipboard, notes, model usage, or LinkedIn outreach - those are commands (mail search, laptop status, clipboard, notes, quota, linkedin crm, applications, jobs).',
        "",
        "Rules:",
        "- Understand any phrasing: fix typos, translate Hinglish, ignore politeness filler.",
        "- NEVER invent email addresses, URLs, company names, or file paths. If one is needed and missing, ask with clarify.",
        "- Keep the user's actual meaning; do not add steps they did not ask for.",
        "- A request to do several things returns several commands in order.",
        "- Output JSON only. No prose, no markdown fences.",
        "",
        memory,
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `Message: ${userText}` },
  ];
}

/** Parse the model's route answer. Returns null when unusable (caller falls back to regex/chat). */
export function parseModelRoute(raw: string): Route | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: any;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (data && Array.isArray(data.commands) && data.commands.length && data.commands.every((c: unknown) => typeof c === "string" && c.trim())) {
    return { kind: "commands", commands: data.commands.map((c: string) => c.trim()).slice(0, 6) };
  }
  if (data && typeof data.clarify === "string" && data.clarify.trim()) {
    return { kind: "clarify", question: data.clarify.trim() };
  }
  if (data && data.chat === true) return { kind: "chat" };
  return null;
}

type ChatFn = (messages: ChatMessage[]) => Promise<string>;

/** Ask the model race to route one user message. Null = unusable, caller falls back to the regex cascade. */
export async function routeWithModel(text: string, chat: ChatFn, memory = ""): Promise<Route | null> {
  try {
    const raw = await chat(routerPrompt(text, memory));
    return parseModelRoute(raw);
  } catch {
    return null; // model trouble must never block the user's words
  }
}
