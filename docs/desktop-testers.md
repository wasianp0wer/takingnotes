# TakingNotes desktop: guide for testers

Thanks for trying the TakingNotes desktop app. This build is for Macs with
Apple Silicon (M1 or later). It isn't signed by Apple, so macOS needs one extra
step the first time you open it.

## 1. Install and open the app

1. Open `TakingNotes-<version>-arm64.dmg` and drag **TakingNotes** onto
   **Applications**.
2. Open TakingNotes from Applications. macOS says it can't verify the
   developer, and offers **Done** or **Move to Trash**. Choose **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to the
   **Security** section, and click **Open Anyway** next to the message about
   TakingNotes. Confirm with your password or Touch ID, then click
   **Open Anyway** again.

You only need to do this once per version.

**If that doesn't work** (for example, macOS says the app "is damaged"), run
this once in Terminal, then open the app normally:

```sh
xattr -dr com.apple.quarantine /Applications/TakingNotes.app
```

This removes the "downloaded from the internet" flag that triggers the check.

## 2. Install Ollama and the model

Handwriting transcription runs on your Mac through Ollama.

1. Install Ollama from <https://ollama.com/download> and open it. It runs in
   the menu bar.
2. In Terminal, download the model (several GB, so this takes a while):

   ```sh
   ollama pull gemma4:12b
   ```

3. In TakingNotes, open **Settings** (the gear at the top right). Under
   **Handwriting transcription** it should say **Ollama ready**. If it doesn't,
   it tells you what's missing (Ollama not running, model not installed, or
   requests being refused) and how to fix it. Click **Check again** after
   fixing it.

**If it says Ollama refused the app's requests**, Ollama is set to accept
requests only from certain addresses, and this app's (`app://*`) isn't one of
them. In Terminal, run:

```sh
launchctl setenv OLLAMA_ORIGINS "app://*"
```

Then quit Ollama (menu bar icon → **Quit Ollama**), open it again, and click
**Check again**. The setting lasts until you restart your Mac; run the command
again after a restart if the message comes back.

Audio transcription (Whisper) needs no setup. The model downloads the first
time you transcribe a recording and is cached after that, so the first time
needs an internet connection.

## 3. Microphone and Bluetooth permission

macOS asks for each one the first time the app needs it:

- **Microphone:** the first time you press **Record**. Click **Allow**.
- **Bluetooth:** the first time you press **Connect** for a tablet. Click
  **Allow**. The app then shows its own list of nearby tablets; pick yours.

If you clicked **Don't Allow** by mistake, turn it back on in
**System Settings → Privacy & Security → Microphone** (or **Bluetooth**),
switch TakingNotes on, and restart the app.

## 4. Before installing a new version: export a backup

Your notes survive replacing the app, but please make a backup first in case
something goes wrong:

1. Open **Settings**, scroll to **Backup**, and click **Export backup…**. Keep
   the `.tnbackup` file somewhere safe.
2. Quit TakingNotes, then drag the new version into Applications and choose
   **Replace**.

To restore, use **Import backup…** in the same place. Importing **replaces
everything** in the app with the backup's contents. It never merges.

## 5. Where your data lives

Everything stays on your Mac, in:

```
~/Library/Application Support/TakingNotes
```

(In Finder: **Go → Go to Folder…** and paste that path.) Deleting the app
doesn't delete this folder. Delete the folder only if you want to erase all
your notes, and export a backup first.

## 6. Reporting a problem

Please include:

- **The version.** Open **Settings** and scroll to **Backup**. The line under
  the heading reads `TakingNotes <version>`, for example `TakingNotes 0.24.0`.
- Your macOS version (Apple menu → **About This Mac**).
- Which tablet you used, if any, and whether it was over Bluetooth or USB.
- What you did, what you expected, and what happened instead. A screenshot
  helps.
