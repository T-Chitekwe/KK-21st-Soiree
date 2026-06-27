# K & K — 21st Soirée RSVP System

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
```

The app runs at: **http://localhost:3000**

---

## Admin Dashboard

URL: `http://localhost:3000/admin/login`

Default credentials:
- **Username:** `admin`
- **Password:** `soiree2025`

> ⚠️ Change the password before going live! Set environment variables:
> ```
> ADMIN_USER=your_username
> ADMIN_PASS=your_secure_password
> SESSION_SECRET=a_long_random_string
> ```

---

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Name Entry | `/` | Guest enters first & last name |
| RSVP | `/rsvp` | Attending / Not Attending choice |
| Confirmation | `/confirmation` | Result shown to guest |
| Admin Login | `/admin/login` | Host login |
| Admin Dashboard | `/admin/dashboard` | View all responses |
| Export CSV | `/admin/export` | Download responses as CSV |

---

## Deploying (Free Options)

### Render.com (Recommended)
1. Push code to GitHub
2. Go to render.com → New Web Service
3. Connect repo, set:
   - Build command: `npm install`
   - Start command: `node server.js`
4. Add environment variables in Render dashboard

### Railway.app
1. Push to GitHub
2. New project → Deploy from GitHub
3. Add environment variables

---

## Database
Responses are stored in `rsvp.db` (SQLite, auto-created on first run).
Back this file up regularly to preserve your RSVP data.
