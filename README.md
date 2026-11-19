# VoIP analytika

Lokální webový pilot pro průchod od anonymizovaného WAV a CDR až k manažerskému přehledu. Zdroj **Ukázkové hovory** obsahuje fiktivní data za září a říjen 2026. Jeden ukázkový hovor obsahuje českou syntetickou nahrávku vytvořenou pomocí [meSpeak](https://github.com/btopro/mespeak). Zdroj **Importované hovory** se plní samostatně.

## Spuštění

Vyžaduje Node.js 24 nebo novější. Instalace balíčků není potřeba.

```powershell
node --env-file-if-exists=.env.local server.mjs
```

Otevřete [http://127.0.0.1:4196/](http://127.0.0.1:4196/). Na Windows lze také spustit `spustit-pilot.cmd`. Výchozí adresa serveru je loopback. Databáze SQLite včetně nahrávek se ukládá do `data/pilot.sqlite`. Volitelně lze nastavit `VOIP_DB` a `PORT`. Pilot je určený pro provoz jedním uživatelem v důvěryhodném prostředí.

### Docker Compose

V kořeni repozitáře spusťte následující příkaz. Docker uloží SQLite a audio do pojmenovaného svazku `voipmonitor-analytics_pilot-data`.

```sh
docker compose up -d --build --wait
```

Pro otevření z místní sítě nastavte `VOIP_BIND_IP` na LAN adresu hostitele v souboru `.env` vedle `compose.yaml`. Volitelná proměnná `VOIP_WEB_PORT` mění port na hostiteli. Webový pilot nemá vlastní přihlašování. Pro provoz přes reverzní proxy použijte externí adresu v `VOIP_PUBLIC_ORIGIN` a zachovejte původní hlavičku Host.

Nastavení konektoru patří do `.env.local`. Po jeho změně použijte `docker compose up -d --force-recreate --wait`. Po aktualizaci kódu použijte `docker compose up -d --build --wait`. Svazek se při obnově kontejneru zachová.

## Příprava dat

1. Před exportem odstraňte telefonní čísla, jména a identifikátory ze sloupců CSV, názvů souborů a vyslovených pasáží v audiu. Použijte stejné náhradní ID v CSV a v názvu nahrávky.
2. Exportujte CSV v UTF-8 se sloupci `cdrId` a `calldate`. Podporované oddělovače jsou středník, čárka a tabulátor. Datum bez časové zóny se čte jako čas v Praze. Čas s uvedeným posunem se přepočítá na pražský čas.
3. Pojmenujte soubor například `VPM-1001.wav` pro `cdrId` rovné `VPM-1001`. Při jiném názvu přidejte do CSV sloupec `audio_file`. WAV musí být 16bitový PCM, mono nebo stereo, 8 až 48 kHz.
4. V **Import dat** vyberte CSV a WAV. Aplikace vypíše chyby v párování a uloží platné CDR. Chybějící WAV lze doplnit opakováním importu se stejným CSV. Identitu hovoru tvoří dvojice `id_sensor` a `cdrId`. Tento pilot předpokládá jednu instalaci VoIPmonitoru.

Volitelná pole jsou `id_sensor`, `branch`, `connect_duration` v sekundách, `mos` na škále 0–5, `jitter_ms` a `packet_loss_pct`. Při absenci `connect_duration` použije import `duration`. Přijímá i sloupce VoIPmonitoru `mos_min_mult10`, `a_avgjitter_mult10`, `b_avgjitter_mult10` a `packet_loss_perc_mult1000`. Pokud není uvedený `jitter_ms`, vezme se vyšší z dostupných průměrů obou směrů. Prázdné hodnoty se zachovají jako chybějící.

Příklad je v `examples/cdr.csv` a `examples/VPM-1001.wav`. CSV obsahuje druhý záznam bez WAV, který umožňuje ověřit vyhodnocení pokrytí. Limity jedné dávky jsou 5 000 řádků CDR, 60 WAV a 96 MiB včetně hlaviček. Jeden WAV má limit 32 MiB a 60 minut.

## Přímý import z VoIPmonitoru

Zkopírujte `pilot.env.example` do `.env.local`. Nastavte adresu GUI včetně případného podadresáře, například `https://voipmonitor.example.cz/voipmonitor`, a místní účet VoIPmonitoru s oprávněním číst CDR a nahrávky. Do `VOIPMONITOR_URL` lze zadat také rovnou celou adresu `php/api.php`. Server používá přihlašovací údaje pouze v těle požadavků. Pro připojení použijte HTTPS. Soubor `.env.local` a databáze s audiem jsou vyloučené z Gitu.

Po restartu otevřete **Import dat → Přímý import z VoIPmonitoru** a vyberte období až 31 dní. Volitelně zadejte ID sondy. Volba **Stáhnout WAV** přidá dostupné nahrávky spojených hovorů v podobě uložené ve VoIPmonitoru. Pro anonymizovaný pilot lze připojit testovací instalaci s odpovídajícími nahrávkami. Základní import ukládá ID, čas, sondu a dostupné metriky. Pole s telefonními čísly, SIP Call-ID a IP adresami se neukládají.

Import běží na pozadí po dnech přes `getVoipCalls` a `getVoiceRecording`. Při chybě zvuku zůstane CDR uložený. Opakováním importu se doplní chybějící WAV. Při opakování zůstávají uložené výsledky analýzy a CDR se stejným `id_sensor` a `cdrId` se nezduplikují. Zadávejte interval v místním čase instalace VoIPmonitoru. Pro údaje bez časového posunu pilot předpokládá Evropu/Prahu.

Při `VOIPMONITOR_QOS=1` se navíc aplikace pokusí doplnit MOS, jitter a ztrátovost z dokumentovaného výpisu CDR přes přihlášenou relaci. Dostupnost závisí na verzi a oprávnění účtu. Pokud se rozšířený výpis nepodaří, stav importu zobrazí upozornění a základní import pokračuje. [VoIPmonitor Web API](https://www.voipmonitor.org/doc/WEB_API)

## Lokální analýza

Spusťte [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) s vícejazyčným modelem, například `ggml-small.bin`. Použijte verzi s podporou výstupu `verbose_json` a časových značek.

```powershell
whisper-server -m ggml-small.bin --host 127.0.0.1 --port 8080 -l cs
```

Spusťte [Ollama](https://docs.ollama.com/capabilities/structured-outputs) s jedním nebo více již staženými lokálními modely a restartujte webový pilot s nastavením níže. Názvy modelů upravte podle vlastního prostředí. Pro plně lokální režim používejte lokálně uložené modely a vypněte cloudové funkce v Ollama.

```powershell
$env:WHISPER_URL = 'http://127.0.0.1:8080'
$env:WHISPER_LANGUAGE = 'cs'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:OLLAMA_MODELS = 'qwen3:4b'
node --env-file-if-exists=.env.local server.mjs
```

V **Hovory** zvolte model a spusťte analýzu čekajících nahrávek. U jednotlivého hovoru lze zvolit jiný model. Přepis zůstane uložený i při selhání souhrnu. Whisper dostává nahrávku převedenou na mono 16 kHz a Ollama dostává přepis s čísly segmentů. Sentiment je odhad z obsahu rozhovoru. U témat a trendů se počítá s posledním uloženým výsledkem a s ručními opravami.

## Data pro reporty

`GET /api/report` poskytuje denní či týdenní časovou řadu, souhrn za období, pokrytí a srovnání. `GET /api/calls` poskytuje seznam a stránkování, `GET /api/calls/<key>` detail včetně přepisu a souhrnu a `GET /api/export.csv` export. Přehled, seznam i export přijímají `dataset`, `from`, `to`, `branch`, `topic`, `sentiment` a `q`. Výchozí zdroj API je `pilot`, ukázkový je `demo`. Aplikace předává výběr období z rozhraní. Export může obsahovat i celé přepisy pomocí `includeTranscript=1`.

## Ověření

```powershell
node --test
```

Testy ověřují ruční import, doplnění WAV, export a zpracování přes simulované odpovědi Whisperu a Ollama. Test konektoru používá simulovaný VoIPmonitor včetně rozšířeného CDR API. Ověření proti konkrétní instalaci vyžaduje její adresu a místní účet.
