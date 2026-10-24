# Venue Network Atlas

A shared directory of every venue: address, main contact, network equipment, circuits, IP addressing and site diagrams.

- **Front end:** plain HTML, CSS and JavaScript hosted on GitHub Pages. There is no build step.
- **Back end:** [Supabase](https://supabase.com), which provides the Postgres database, email sign-in and file storage for diagrams.

Venue data never lives in this repository. It is stored in Supabase, and only people on the access list can read it. The repository holds code only, so it is safe even if the repo is public.

## How access works

| Role | Can do |
| --- | --- |
| **viewer** | See every venue, circuit, IP and diagram |
| **editor** | Everything a viewer can, plus add, edit and delete venues and upload diagrams |
| **admin** | Everything an editor can, plus manage the access list and export data |

Sign-in is invite-only. People sign in with their email address and get a one-time link or code. If an email isn't on the access list, the database refuses to create a login for it.

Every save and delete is recorded with who made it and when. Open a venue and click **Change history** to see its log.

## Setup (about 20 minutes, once)

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
2. Name it `venue-network-atlas`, choose a US region, and set a strong database password. Save the password in your password manager.
3. Wait for the project to finish provisioning.

### 2. Create the database

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.

This creates the tables, the access rules and the private `diagrams` storage bucket. The script is safe to run again later.

### 3. Make yourself the first admin

In the SQL Editor, run this with your own details:

```sql
insert into public.allowed_users (email, role, display_name)
values ('you@legends.net', 'admin', 'Your Name');
```

### 4. Load the venue data

Open `venue-atlas-seed.sql` in the SQL Editor and click **Run**. That file was sent separately and is not in this repo. It should finish by showing **106 venues, 80 circuits, 53 IP entries**.

> Don't commit the seed file. It contains contacts, public IPs and circuit IDs, and `.gitignore` blocks it as a safeguard.

### 5. Configure email sign-in

In the Supabase dashboard, under **Authentication**:

1. **URL Configuration:** set **Site URL** to your GitHub Pages address, for example `https://YOUR-USERNAME.github.io/legends-venue-atlas/`. Add the same address under **Redirect URLs**.
2. **Emails → Magic Link** template: add the one-time code so people can type it instead of clicking the link. Corporate mail filters such as Microsoft Defender sometimes "pre-click" links, which uses them up. For example:
   ```html
   <h2>Sign in to Venue Network Atlas</h2>
   <p>Your sign-in code is <strong>{{ .Token }}</strong></p>
   <p>Or <a href="{{ .ConfirmationURL }}">click here to sign in</a>.</p>
   ```
3. **Emails → SMTP Settings:** Supabase's built-in email sender only sends a few emails per hour and is meant for testing. Before you roll the app out to the team, connect your company's mail service or a provider like SendGrid or Postmark.

### 6. Connect the app to Supabase

1. In Supabase, open **Project Settings → API Keys** and copy the **publishable key**. Older projects call it the **anon key**.
2. Copy the **Project URL**.
3. Paste both into [`config.js`](config.js).

The publishable key is designed to be public, because the access rules protect the data. **Never** put the secret or `service_role` key in this repo.

### 7. Publish on GitHub Pages

```bash
cd legends-venue-atlas
git init
git add .
git commit -m "Venue Network Atlas: web app and Supabase schema"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/legends-venue-atlas.git
git push -u origin main
```

Then, in the GitHub repo:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/ (root)**.
3. Click **Save**.

After a minute or two the site is live at `https://YOUR-USERNAME.github.io/legends-venue-atlas/`. If that address differs from what you entered in step 5, update the Supabase URL settings to match.

### 8. Add your team

Sign in, click **Manage access** at the bottom of the venue list, and add each person with a role. They can sign in right away.

## Day-to-day

- **Edit a venue:** open it, click **Edit venue**, make your changes, then click **Save venue**. If someone else saved the same venue while you were editing, the app refuses to overwrite their change and asks you to reopen it.
- **Venues marked "Needs review":** these have conflicting data from the original spreadsheets. Each one has a note explaining the conflict. Fix the data and delete the note to clear the flag.
- **Backups:** admins can click **Export JSON** at any time and keep the file somewhere safe. Check which automatic backups your Supabase plan includes.
- **Inactive free projects:** Supabase pauses free projects after a period with no activity. If the app stops loading, open the Supabase dashboard and click **Restore**. Your data is kept.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | Look and layout, light and dark themes |
| `app.js` | All app behaviour: sign-in, venues, editing, diagrams, access list, export |
| `config.js` | Your Supabase project URL and publishable key |
| `supabase/schema.sql` | Database tables, access rules, save and delete functions, storage bucket |
