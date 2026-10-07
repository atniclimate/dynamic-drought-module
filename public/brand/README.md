# ATNI marks

The sidebar and embed wordmark is typeset in supplied Spartan MB 800. The existing `atni-seal.png` favicon is unchanged. The existing approved `atni-climate-lockup.png` is reused in acknowledgements and the print footer, with SHA256 `dc1abc5dec18d3f376f8088b5d3e62a91d479b6b3987fdba92767649eb095fc2`.

About-card seal derivatives come from the design bundle's `assets/logos/atni-seal-on-dark.png`, source SHA256 `29d79857e53f591700c819e6389677feb9eeec74cf6053b5816082e308f28ff1`. The source artwork is provisional upstream; derivatives resize without recoloring or distortion. White circular plate styling belongs to CSS, not the image bytes.

Generation uses Windows PowerShell 7 and System.Drawing HighQualityBicubic with SourceCopy, HighQuality pixel offset, transparent 32-bit ARGB output and aspect-preserving centered fit. The recorded .NET runtime is 10.0.12. Run `scripts/build-brand-assets.ps1 -SourcePath <bundle-seal-path> -OutputDirectory <external-output-directory>` from the repository root. Inspect the generated images and compare hashes before copying into this directory; runtime changes can change encoder bytes.

| File | Size | SHA256 |
|---|---|---|
| atni-seal-on-dark-64.png | 64x64 | 1235183114594fbb39181825c5ea19734a75c52e2636e9ed0696925013fd2b5f |
| atni-seal-on-dark-128.png | 128x128 | 95e39ab7ad75acd38849f63c02c327a49d0b9a65926167826ae553f8fbf38619 |

The 64-pixel image serves a 64 CSS-pixel seat; the 128-pixel image serves its 2x density source. The bundle lockup differs from the approved existing lockup and is not substituted.
