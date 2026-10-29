# Potapanje brodova preko PSK

Dvije web stranice igraju potapanje brodova preko zvuka: svaka strana ima PSK enkoder
(odašiljanje kroz zvučnu karticu) i dekoder (prijem s mikrofona/linijskog ulaza). Namijenjeno
radiju s **VOX** upravljanjem: izlaz zvučne kartice ide na mikrofonski ulaz radija, zvuk prijemnika
na ulaz zvučne kartice. Bez radija radi i zvučnik → mikrofon, ili dva taba preko virtualnog kanala.

Bez build koraka i bez ovisnosti: čisti ES moduli.

## Pokretanje

```sh
npm start            # ili: python3 -m http.server 8080 --bind 127.0.0.1
# otvori http://localhost:8080
npm test             # modem kroz simulirani kanal + cijela igra preko kanala s gubicima
```

Mikrofon u pregledniku radi samo u sigurnom kontekstu (`https://` ili `http://localhost`), zato
svaki igrač pokreće igru lokalno na svom računalu. Mreža nije potrebna, sve ide preko zvuka.

**Proba bez radija:** u dva taba istog preglednika odaberi kanal „Virtualni”, upiši različite
pozivne znakove (jedan drugome kao protivnika) i klikni „Pokreni modem” u oba.

## Postavke za radio na VOX-u

- **Razina TX**: smanji dok ALC ne miruje; preglasan PSK se širi i ne dekodira se.
- **VOX predtakt** (zadano 400 ms): preambula se produži da VOX stigne uključiti predajnik prije
  sinkro riječi. Ako se prvi okviri gube, povećaj.
- **Pauza prije odgovora** (zadano 800 ms): koliko se čeka nakon tuđeg signala prije našeg
  odašiljanja, da protivnikov VOX otpusti i njegov radio prijeđe na prijem. Mora biti dulja od
  VOX „hang” vremena na drugoj strani.
- **Frekvencija**: ista na obje strane (zadano 1500 Hz, unutar SSB propusnog pojasa). Klik na
  vodopad postavlja frekvenciju i privlači je na najjači signal; AFC dalje prati pomak do ±¼ brzine.
- **Brzina**: PSK31 je najotporniji, PSK125 najbrži. Obje strane moraju imati istu.
- Obrada glasa (AEC, potiskivanje šuma, AGC) u pregledniku je isključena jer uništava PSK.

Za vrijeme vlastitog odašiljanja prijemnik je utišan, a prije svakog odašiljanja modem čeka da
kanal bude slobodan (DCD i okvir u prijemu).

## Modem (`js/modem.js`)

- Diferencijalni BPSK kao PSK31: bit 0 = obrat faze, 1 = bez promjene; anvelopa oblikovana
  kosinusom pa je spektar uzak.
- Okvir: preambula (32+ obrata) · sinkro riječ `0x1ACFFC1D` (do 2 pogrešna bita) · duljina ·
  do 96 bajtova teksta · CRC-16/CCITT · 8 obrata na kraju.
- Prijem: miješanje na osnovni pojas, 2× biquad NP, decimacija na 16 uzoraka po simbolu, Hannov
  filtar duljine simbola, takt po vršku energije, AFC kvadriranjem diferencijalne faze. DCD je
  kvaliteta faze (prosjek `cos 2θ`).

## Protokol (`js/session.js`)

Svaka poruka je jedan okvir s tekstom `OD>ZA NAREDBA argumenti`, čitljiv i u dnevniku:

| Poruka | Značenje |
|---|---|
| `9A1ABC>* CQ` | tražim igru |
| `R <nonce> <0\|1>` | spreman; 1 = već znam tvoj nonce. Veći nonce puca prvi |
| `F <seq> B7` | pucanj |
| `X <seq> B7 M\|H\|S [B5H3] [W]` | rezultat; uz `S` ide potopljeni brod, `W` = kraj igre |
| `N` | nova igra (brodovi ostaju) |
| `C <tekst>` | poruka |

Pogodak znači da strijelac puca ponovno. Pucanj bez odgovora ponavlja se s istim `seq`-om
(do 5 puta, zatim gumb „Ponovi”); branitelj na ponovljeni `seq` šalje spremljeni odgovor.
`R` se ponavlja sve rjeđe dok se protivnik ne javi. Brodovi (5, 4, 3, 3, 2) se ne smiju dodirivati
ni dijagonalno, pa se oko potopljenog broda more automatski označi.
