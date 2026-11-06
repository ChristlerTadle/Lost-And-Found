# BukSU Lost and Found

The current application has a separate static frontend and Express REST API. Both use the existing MongoDB data and shared backend services. The archived PHP and EJS implementations are retained under `archived/` for reference and are not part of the current run setup.

## Requirements

- Node.js 20 or newer
- MongoDB Community Server

## Run locally

From PowerShell in the project folder, install dependencies once:

```powershell
npm.cmd install
```

Start MongoDB, then open two PowerShell windows at the project root.

Start the REST API:

```powershell
npm.cmd start
```

Start the frontend in the second window:

```powershell
npm.cmd run start:frontend
```

Open `http://localhost:5173`. The frontend calls the API at `http://localhost:3001/api` by default. See [REST-SETUP.md](./REST-SETUP.md) for ports, environment settings, and Google OAuth setup.

## Project layout

- `frontend/`: static browser application and frontend server
- `backend/`: REST API server, routes, controllers, middleware, and API tests
- `src/`: MongoDB connection and shared application services used by the API
- `assets/app.css`: shared stylesheet used by the frontend
- `uploads/` and `private_uploads/`: item image storage
- `archived/`: previous implementations and utilities retained for reference

Run the API tests with:

```powershell
npm.cmd test
```
