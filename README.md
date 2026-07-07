# fixFivemWeapons

Browser-only FiveM weapon / clothing fixer.

- repacks raw weapon or clothing mod files into a FiveM resource ZIP
- expands nested non-encrypted RPF7 archives in the browser
- generates `fxmanifest.lua` `data_file` entries for weapon, vehicle, ped, and clothing apparel metadata
- preserves freemode clothing stream containers such as `mp_m_freemode_01_mp_m_*` and `mp_f_freemode_01_mp_f_*` to avoid drawable/texture collisions
- detects replace-style weapon packs such as `w_sb_smg.*` and can output them as addon weapons by default, with a checkbox to keep replace output
