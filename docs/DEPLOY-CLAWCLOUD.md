# Deploy to ClawCloud Run (free tier, no credit card)

ClawCloud Run's free plan gives **$5 of credits every month for free** when you
bind a GitHub account that is at least **180 days old**. No credit card is
required. A 0.5 vCPU / 1.5 GB RAM / 5 GB storage instance costs about
**$4.60/month**, inside the free credits.

Sources (checked 2026-10-20):
- Pricing: https://docs.run.claw.cloud/clawcloud-run/pricing
- Billing & free credits: https://docs.run.claw.cloud/clawcloud-run/billing-and-usage

## Before you start

1. A GitHub account **at least 180 days old** (ClawCloud checks this when you bind it).
2. This repo pushed to that GitHub account (or any repo ClawCloud can build from).
3. A strong password for the control center (this is `APP_PASSWORD` below).
   The app stores your mail credentials, so never deploy it without this set.

## Steps

1. **Sign up** at https://run.claw.cloud and bind your GitHub account when
   prompted. You do the signup yourself - no one else should ever see these
   credentials.
2. **Create an app**: App Launchpad → Create App.
   - Source: your GitHub repo (ClawCloud builds the `Dockerfile` at the repo root).
   - Port: `8787`.
   - Resources: **0.5 vCPU / 1.5 GB RAM** (do not go below 1.5 GB - headless
     Chromium needs the headroom).
3. **Add a persistent volume**: mount a **5 GB** volume at `/data`.
   This holds the SQLite database, your settings, and the browser profile.
   Without it every restart wipes everything. Cost: about $0.60/month.
4. **Set environment variables** in the app settings:
   - `APP_PASSWORD` = your chosen control-center password (required)
   - `MODEL_PROVIDER`, `MODEL_API_KEY` (or enter them later in the Setup tab)
   - Mail settings can be entered later in the Setup tab too.
   - `HOST`, `PORT`, `AGENT_DATA_DIR`, `NO_OPEN` are already set by the Docker image.
5. **Deploy** and open the public URL ClawCloud gives you. You should see the
   login screen first - that means the gate is working.
6. Finish setup inside the app: Setup tab → model key, email account, resume.

## Cost math (free plan)

| Resource | Price | This app | Monthly |
|---|---|---|---|
| CPU | $4/vCPU | 0.5 vCPU | $2.00 |
| RAM | $2/GB | 1.5 GB | $3.00 |
| Storage | $0.12/GB | 5 GB | $0.60 |
| **Total** | | | **~$5.60** |

That is slightly over $5 if Chromium idles high; dropping the volume to 2 GB
(~$0.24) or RAM to 1.25 GB keeps it under. Check the billing page after the
first day and tune once.

## Honest caveats

- **Cloud IPs get more challenges.** LinkedIn and Google treat datacenter IPs
  as suspicious. Job-hunt, apply, and LinkedIn features are more likely to hit
  captchas or blocks from the cloud than from your home connection. The app
  pauses and asks when it hits a challenge - do those steps yourself in the
  Browser tab.
- **Free tiers have no SLA.** ClawCloud can throttle free-plan workloads or
  change terms. Keep a local copy of the repo and your resume.
- **Backups.** Your data lives on the volume at `/data`. If you delete the app,
  the data goes with it. Export your tracker (Jobs tab → CSV) regularly.
- If the credits ever stop covering the instance, the app enters a grace
  period and stops after 7 days - you would get email warnings first.

## Updating

Push to the repo, then hit **Redeploy** in ClawCloud. The volume at `/data`
survives redeploys, so your settings and history stay.
