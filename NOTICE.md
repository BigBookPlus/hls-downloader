# Notice

This project implements **standard HLS AES-128** as described in [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216) (`#EXT-X-KEY:METHOD=AES-128`). It decrypts MPEG-TS or fMP4 (`#EXT-X-MAP`) segments with the key and IV from the playlist, then writes a local file.

It is **not** a Widevine, FairPlay, PlayReady, or `SAMPLE-AES` circumvention tool. It does not unwrap custom shells, XOR prefixes, or site-specific DRM.

## No warranty, no endorsement

The software is provided under the MIT License, as-is. The authors are not lawyers and this file is not legal advice.

You are responsible for using the extension only on media you have the right to save. Misuse — including downloading or distributing content you do not have rights to — is your responsibility, not the authors'.

The authors do not operate a server that collects playlists, cookies, or keys. They do not provide paid support, site-specific cracking, or help bypassing logins or paywalls.

## Chrome Web Store

This extension is intended to be loaded unpacked for personal use. It is not submitted to the Chrome Web Store and has no paid edition.
