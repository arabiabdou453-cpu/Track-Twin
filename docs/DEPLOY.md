# Hosting Track Twin

The site and the server are one Node program, so one host runs both. It needs:
- Node 24 or newer (the Dockerfile provides it).
- A **persistent disk** mounted at `/app/data`. The database is a SQLite file, and without a disk every restart erases it.
- A long-lived process. Live updates and the 3-second timer stop on serverless hosts such as Vercel, so do not use them.
- HTTPS, which hosts provide, so phone GPS works.

## Settings to give the host (never put them in Git)
| Name | Value |
|---|---|
| `OPERATOR_PIN`, `CREW_PIN`, `HOSPITAL_PIN` | new 6-digit codes, different from the local ones |
| `SESSION_SECRET` | 64 random characters |
| `PUBLIC_URL` | the address the host gives you, with `https://` |
| `SMSGATE_USERNAME`, `SMSGATE_PASSWORD` | from the SMS Gateway app, only if SMS is wanted |
| `PORT` | the port the host expects, often set by the host itself |

## Steps (Render, Railway or Fly.io all work with the Dockerfile)
1. Create an account on the host and connect the GitHub repository.
2. Choose "Docker" as the type, and add a disk of 1 GB mounted at `/app/data`.
3. Add the settings above and deploy.
4. Open the address, log in, and run one mission with a test phone.

## Before making it public
- Remove test incidents and personal numbers from the database (start with an empty disk).
- Review the Git history and the official figures on the landing page.
- Keep the demo-only wording: prototype, simulated lights, no official link.
