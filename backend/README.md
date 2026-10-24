# TrialKeeper backend

## Create the first coordinator

The bootstrap script creates a coordinator only when no coordinator exists.
It never updates an existing account. Run it once from PowerShell:

```powershell
Set-Location "C:\Users\damin\Trialkeeper\backend"
node .\scripts\bootstrapCoordinator.js
```

The script loads this backend's `.env` regardless of the current directory. It
asks for the coordinator name and email, then requests the password using a
hidden interactive prompt. The password is not echoed.

To supply the name and email using environment variables instead, set these
values for the current PowerShell process and start the script:

```powershell
$env:BOOTSTRAP_COORDINATOR_NAME = "Coordinator Name"
$env:BOOTSTRAP_COORDINATOR_EMAIL = "coordinator@example.com"
node .\scripts\bootstrapCoordinator.js
Remove-Item Env:\BOOTSTRAP_COORDINATOR_NAME
Remove-Item Env:\BOOTSTRAP_COORDINATOR_EMAIL
```

You can also set `BOOTSTRAP_COORDINATOR_PASSWORD` in a secure process
environment, but do not type a literal password into a command: it can be
retained in shell history. Prefer the hidden prompt, or use a secret manager
or protected process environment when automation requires a password variable.
Do not paste credentials into chat or commit them to source control.
