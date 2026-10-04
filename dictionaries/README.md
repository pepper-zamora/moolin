# Bundled spelling dictionaries

The English Hunspell dictionaries Moolin ships with, so English spell
checking never needs a download (see `src/spellcheck.ts`). They're copied
unchanged from the `hunspell_dictionaries.zip` attached to Electron's
v44.5.1 release, which Chromium builds from its
[hunspell_dictionaries](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/)
repository; the dictionaries' sources and licenses are there.

Chromium looks for each language's dictionary by an exact file name that
includes a version (`en-US-10-1.bdic`). If an Electron update changes those
names, these files stop being found and English is downloaded like any other
language; so when updating Electron, compare its zip's English file names
with these, and replace the files if they differ.
