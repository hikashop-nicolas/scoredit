# Sound packs

`plucked.sf3`: the plucked instruments of General MIDI (guitars 24-31, basses 32-39, harp 46,
sitar, banjo, shamisen, koto 104-107), cut out of MuseScore_General.sf3 by S. Christian
Collins, MIT licence (see `LICENSE-MuseScore_General.md`). Rebuild it with
`node scripts/make-sound-packs.mjs <path to MuseScore_General.sf3>`.

The samples keep their original compressed (Ogg Vorbis) form; nothing is re-encoded.
