# DART Meadow for Android

A full-screen WebView around https://dartmeadow.space, so the game updates itself and the APK rarely changes (about 55 KB).

- Download: https://dartmeadow.space/android-dist/DartMeadow.apk, or the "latest" release of this repo.
- Needs Android 8+ and a current Android System WebView / Chrome. The game uses WebGPU where available and falls back to WebGL2.
- Build: `android/build.sh` (aapt2, javac, d8, apksigner; no Gradle). The signing key is not in the repo.
- Google sign-in pop-ups are blocked inside any WebView; sign in with the email option, or play without an account.
