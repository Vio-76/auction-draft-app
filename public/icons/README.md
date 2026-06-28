# Role icons

Drop transparent-background PNGs here, named per role (lowercase):

```
top.png  jungle.png  mid.png  adc.png  support.png  fill.png
```

They're referenced by `public/css/icons.css` and shown on the spectator board and the
team cards. If a file is missing, the board falls back to a short text label for that
role, so icons are optional.

(This replaces the old Apps Script setup that read the icons from Google Drive and
base64-inlined them — now they're just static files served by Express.)
