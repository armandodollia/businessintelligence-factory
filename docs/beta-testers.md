# Business Intelligence Factory: guide for beta testers

Thank you for trying this. This guide takes you from the download to your first research run, and
tells you how to send us your feedback and how to remove everything again.

## What this app is

The app researches a business for you. It asks you about the business, sends AI agents to look at
the market and the competitors, checks their results, and shows you findings and recommendations
that you can rate.

Three things to know before you start:

- **It runs on your computer.** There is no account with us and no server of ours. Your data stays
  on your computer.
- **It uses your own AI subscription.** The agents are programs you install yourself (Claude Code,
  Codex or OpenCode) and sign in to with your own account. Research uses that account, and can use
  a lot of it. See "Costs" below.
- **It sends us nothing.** We only see what you choose to send. See "Sending feedback" below.

## What you need

- A Mac with macOS 13 or later, or a PC with Windows 10 or 11 (64-bit).
- Google Chrome. The agents use it to look at websites. They use their own separate Chrome
  profile, never your everyday one.
- One of the agent programs, installed and signed in (step 2).

### A note on Windows

**Windows builds are new.** This is what has and has not been tried, on one Windows 11 machine:

- Tried: the automated tests pass. The installer was built, installed, started and removed again.
  The app found the agent programs, ran a real interview turn, stopped a running agent when the app
  was closed, and made a feedback file.
- Not tried: opening the app from its Start-menu shortcut, the installer's normal run (it was run
  in its quiet mode), research with Codex, and a signed build.

If something goes wrong on Windows, that is useful to know. Please tell us what you saw.

## 1. Install the app

The builds are not signed. Your computer will warn you the first time you open the app. The steps
below tell you how to open it anyway.

### On a Mac

1. Pick the right file. Open the Apple menu and choose "About This Mac".
   - If it says "Chip: Apple M…", take the file whose name ends in `mac-arm64.dmg`.
   - If it says "Processor: Intel", take the file whose name ends in `mac-x64.dmg`.
2. Open the `.dmg` file. A window opens.
3. Drag "Business Intelligence Factory" onto the "Applications" folder in that window.
4. Open your Applications folder and double-click "Business Intelligence Factory".
5. macOS says it cannot check the app. Close that message (choose "Done", not "Move to Trash").
6. Open System Settings, then "Privacy & Security". Scroll down to "Security". You see a line about
   "Business Intelligence Factory". Click "Open Anyway" and confirm with your password or Touch ID.
7. Click "Open" in the last message. You only do this once.

On macOS 13 or 14 there is a shorter way for steps 5 to 7: hold the Control key, click the app,
choose "Open", then click "Open" again.

If macOS says the app "is damaged and can't be opened", it is not damaged. Open the "Terminal" app,
paste this line, press Return, and then open the app again:

```
xattr -dr com.apple.quarantine "/Applications/Business Intelligence Factory.app"
```

### On Windows

1. Take the file whose name ends in `windows-x64-setup.exe` and double-click it.
2. Windows shows "Windows protected your PC". Click "More info", then "Run anyway".
3. The app installs for you alone (no administrator password is needed) and then starts. You find
   it later in the Start menu and on the desktop.

Your browser may also warn you when you download the file. Choose to keep it.

## 2. Install an agent program and sign in

You need at least one of these. We suggest Claude Code or Codex. OpenCode has not yet finished a
complete research run in our own tests.

| Program | Where to get it | How to sign in |
|---|---|---|
| Claude Code | https://claude.com/claude-code | Open a terminal and type `claude auth login` |
| Codex | https://github.com/openai/codex | Open a terminal and type `codex login` |
| OpenCode | https://opencode.ai | Open a terminal and type `opencode auth login` |

A "terminal" is the app called "Terminal" on a Mac and "Terminal" or "PowerShell" on Windows. You
type a line and press Return (Enter).

Follow the install steps on the program's own page, then sign in with the line from the table.
Each program asks you to sign in with your own account or subscription.

## 3. The first start

The first time, the app opens on its **Settings** page. The first part of the page is called
**"This computer"**. It lists what the app found:

- each agent program: found or not, its version, and signed in or not;
- Google Chrome: found or not.

Next to anything that is missing, it says what to do.

1. If something you installed is shown as missing, quit the app, open it again and look once more.
   Or click **"Check again"**.
2. When at least one agent program is shown as signed in, click **"Write the configuration for
   what was found"**. This sets the app up for the programs you have. Before you click, the line
   under the table may say that research cannot start because the configuration gives roles to a
   program you do not have: this button is what changes that.
3. The line under the table now says "Research can start with …" and names the programs it will
   use. You are ready.

From now on the app opens on its home page. You find this check again under "Settings" at any time.
The app opens on Settings again whenever the check does not pass, or could not be made in time.

Research can start only when every program the configuration uses is found and signed in. One
program that is ready is not enough if a role is given to another one that is missing: the line
under the table says which, and what to do.

This check does not use your AI subscription. It only asks each program for its version and
whether you are signed in.

If you only have OpenCode, research cannot start yet: you first need to choose a model for it in
Settings and give it the roles. The line under the table says so.

## 4. What to try

1. On the home page, under "New workspace", create a workspace for a business. It can be your own
   or one you know well.
2. Open **Interview** and answer the questions about the business.
3. Open **Research** and start a research run. This is the part that takes a long time and uses
   your AI subscription.
4. While it runs, look at **Findings & Evidence**, **Competitors** and **Strategy** as results
   come in.
5. Rate what you see. Accept or reject findings and recommendations, and say why. Your reasons are
   the most useful thing you can give us.

You can leave the app open and do other things. Closing the window quits the app.

### Stopping research

While research is running, the **Research** page shows a button **"Stop research"**. Click it, then
click **"Yes, stop it"**. The agents that are running are stopped, usually within a few seconds, and
nothing more is spent. What was finished is kept: findings, competitors and recommendations stay
where they are. A task that was in the middle of its work is not finished, and its run is shown as
"failed" in the list of runs: that is how a stopped run looks. If an agent was waiting for you (to
log in somewhere, or to approve something), its request is closed and disappears from the page: there
is no agent left to take your answer.

You can start research again later with "Start research". It starts a new run, which uses what was
already found.

The button stops the research of the workspace you are looking at. Research of another workspace
keeps running until you stop it there, and so does an experiment you started in the same workspace.

### If you quit while research is running

Quitting stops the agents too. The app stops every agent program it started and the research
browser before it closes; this can take a few seconds. Nothing keeps running or spending after the
app has closed.

Unlike "Stop research", quitting only interrupts: the next time you start the app, it carries on
with the research where it was. If you do not want that, click "Stop research" before you quit.

A run also ends when it reaches a cost limit (see "Costs").

## Costs

Research uses your own AI account. The app does not charge you anything, but your AI provider may,
depending on your plan.

To protect you, the app is set up with two limits:

- **25 US dollars** for one full research run of a business;
- **100 US dollars** in total for one workspace.

The app counts what the agents use, at the provider's list prices. When a limit is reached, it
starts no new agent and asks you whether to allow more. You see what was spent on the
**Usage & prompts** page of a workspace.

The count is an estimate. Check your provider's own usage page too, especially on the first day.

To change the limits, open Settings and find these lines near the word `budgets`:

```
"pipeline": { "maxCostUsd": 25 },
"workspace": { "maxCostUsd": 100 }
```

Change the numbers and click "Save".

## Where your data is

Everything the app keeps is in one folder:

- Mac: `Library/Application Support/Business Intelligence Factory` in your home folder
- Windows: `%APPDATA%\Business Intelligence Factory`

The easy way to open it: in the app, choose **File > Open data folder**.

In it you find:

- `data`: your workspaces, the research results, and the research browser's own Chrome profile;
- `bif.config.json`: the settings;
- `logs`: a log of what the app did. If something goes wrong, we may ask you for the file
  `server.log` from here. It can contain names of businesses you researched, so look at it before
  you send it;
- `shell`: small files the app window keeps for itself.

Installing a newer build keeps this folder. A beta build does not update itself: to update,
install the newer file the same way as the first.

## Sending feedback

1. In the app, choose **File > Send feedback**.
2. Choose the period (leave it empty for everything) and what the file includes. The standard
   choice holds numbers, timings and your own ratings and reasons. It does not hold your research
   results, the names of the businesses you researched, or the web addresses of the sites that were
   looked at (an address is written as `<url>`, also in a reason or note you typed).
3. Add a note if you like. Tell us what worked, what did not, and what confused you.
4. Click **"Preview"** to see what is in the file.
5. Click **"Save"** and choose where to put the file. The page then says that the file was offered
   for saving: it is where you chose. If you closed the dialog without choosing, no file was written,
   and you can click "Save" again.
6. Send us the file yourself, by email or however we agreed.

The app does not send the file. Nothing leaves your computer unless you send it.

## Removing the app and your data

### On a Mac

1. Quit the app.
2. Drag "Business Intelligence Factory" from the Applications folder to the Trash.
3. To remove your data as well: in Finder, choose "Go > Go to Folder…", paste
   `~/Library/Application Support`, press Return, and move the folder
   "Business Intelligence Factory" to the Trash.

### On Windows

1. Quit the app.
2. Open "Settings > Apps > Installed apps", find "Business Intelligence Factory" and choose
   "Uninstall".
3. To remove your data as well: press the Windows key and R, type `%APPDATA%`, press Enter, and
   delete the folder "Business Intelligence Factory".

Removing the app without step 3 keeps your data, so you can install the app again later and go on.

The research browser also leaves a few temporary files in a folder called `bif-browser-output` in
your computer's temporary folder. You can delete it.

The agent programs (Claude Code, Codex, OpenCode) and Google Chrome are separate. Removing this app
does not remove them or sign you out of them.

## If something goes wrong

- **The app says research cannot start.** Open Settings. In its first part, "This computer", the
  line under the table names the program that is missing, not signed in or without a model. Follow
  the line next to that program, then click "Check again".
- **An agent program is shown as "not found" although you installed it.** Quit the app and open it
  again. If it is still not found, tell us where you installed it.
- **The app shows an error when it starts.** The message names a log file. Send us that file with a
  line on what you did.
- **Anything else.** Write down what you did and what you saw, and put it in the note when you send
  feedback.
