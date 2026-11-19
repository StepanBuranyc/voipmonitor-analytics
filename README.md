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
4. V **Import dat** vyberte CSV a případné WAV. V náhledu přiřaďte sloupce k polím nebo zvolte **Vynechat**. Sloupce označené jako **Kontext pro AI** se ukládají u hovoru a odesílají s přepisem vybranému modelu. Potvrďte **Importovat vybrané sloupce**. Identitu hovoru tvoří dvojice `id_sensor` a `cdrId`. Chybějící WAV lze doplnit opakováním importu. Pilot předpokládá jednu instalaci VoIPmonitoru.

Volitelná pole jsou `id_sensor`, `branch`, `connect_duration` v sekundách, `mos` na škále 0–5, `jitter_ms` a `packet_loss_pct`. Při absenci `connect_duration` použije import `duration`. Přijímá i sloupce VoIPmonitoru `mos_min_mult10`, `a_avgjitter_mult10`, `b_avgjitter_mult10` a `packet_loss_perc_mult1000`. Pokud není uvedený `jitter_ms`, vezme se vyšší z dostupných průměrů obou směrů. Prázdné hodnoty se zachovají jako chybějící.

Příklad je v `examples/cdr.csv` a `examples/VPM-1001.wav`. CSV obsahuje druhý záznam bez WAV, který umožňuje ověřit vyhodnocení pokrytí. CSV může mít 64 MiB a 50 000 řádků. Pro jednu dávku platí nejvýše 60 WAV a 96 MiB včetně hlaviček. Jeden WAV má limit 32 MiB a 60 minut.

### Hotové přepisy z CSV

Uložte jeden hovor na řádek podle vzoru `examples/transcripts.csv`. Náhled předvyplní běžné názvy jako `cdr_id`, `cdr_started_at` a `transcription`. Vlastní názvy přiřaďte v náhledu. U už načteného hovoru stačí ID a přepis. Pokud se stejné ID vyskytuje na více sondách, přiřaďte také ID sondy. Importovaný přepis můžete otevřít a vyhledat ihned.

## Přímý import z VoIPmonitoru

Zkopírujte `pilot.env.example` do `.env.local`. Nastavte adresu GUI včetně případného podadresáře, například `https://voipmonitor.example.cz/voipmonitor`, a místní účet VoIPmonitoru s oprávněním číst CDR a nahrávky. Do `VOIPMONITOR_URL` lze zadat také adresu zakončenou `admin.php`, `index.php` nebo `php/api.php`. Server posílá přihlašovací údaje v těle formulářového POST požadavku. Pro připojení použijte HTTPS. Soubor `.env.local` a databáze s audiem jsou vyloučené z Gitu.

Po restartu otevřete **Import dat → Přímý import z VoIPmonitoru** a vyberte období až 31 dní. Volitelně zadejte ID sondy. Volba **Stáhnout WAV** přidá dostupné nahrávky spojených hovorů v podobě uložené ve VoIPmonitoru. Pro anonymizovaný pilot lze připojit testovací instalaci s odpovídajícími nahrávkami. Základní import ukládá ID, čas, sondu a dostupné metriky. Pole s telefonními čísly, SIP Call-ID a IP adresami se neukládají.

Import běží na pozadí po dnech přes `getVoipCalls` a `getVoiceRecording`. Při chybě zvuku zůstane CDR uložený. Opakováním importu se doplní chybějící WAV. Při opakování zůstávají uložené výsledky analýzy a CDR se stejným `id_sensor` a `cdrId` se nezduplikují. Zadávejte interval v místním čase instalace VoIPmonitoru. Pro údaje bez časového posunu pilot předpokládá Evropu/Prahu.

Při `VOIPMONITOR_QOS=1` se navíc aplikace pokusí doplnit MOS, jitter a ztrátovost z dokumentovaného výpisu CDR přes přihlášenou relaci. Dostupnost závisí na verzi a oprávnění účtu. Pokud se rozšířený výpis nepodaří, stav importu zobrazí upozornění a základní import pokračuje. [VoIPmonitor Web API](https://www.voipmonitor.org/doc/WEB_API)

## AI analýza přes API

V `.env.local` nastavte klíč vybraného poskytovatele nebo adresu vlastního modelového serveru. Proměnné s názvy modelů přijímají seznam oddělený čárkou. Vyberte model s podporou strukturovaného výstupu JSON Schema.

| Poskytovatel | Proměnné | Výchozí model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY`, volitelně `OPENAI_MODELS` | `gpt-4.1-mini` |
| Google Gemini | `GEMINI_API_KEY`, volitelně `GEMINI_MODELS` | `gemini-4-hydrogen` |
| xAI Grok | `XAI_API_KEY`, volitelně `XAI_MODELS` | `grok-4.7` |
| Groq | `GROQ_API_KEY`, volitelně `GROQ_MODELS` | `openai/gpt-oss-20b` |
| Vlastní OpenAI kompatibilní server | `CUSTOM_AI_URL`, `CUSTOM_AI_MODELS`, volitelně `CUSTOM_AI_API_KEY` | |
| Ollama | `OLLAMA_URL`, `OLLAMA_MODELS` | |

Jako `CUSTOM_AI_URL` lze zadat například `https://model.example.cz/v1`. Aplikace použije Chat Completions a JSON Schema. Pro Ollama použijte adresu její služby dostupnou z webové aplikace. Klíče zůstávají v konfiguraci serveru.

Po restartu otevřete **AI analýza**. Vyberte poskytovatele a model a spusťte analýzu čekajících hovorů nebo test na fiktivním přepisu. Stejné modely lze vybírat v detailu hovoru. Modelu se předávají přepis a výslovně zvolený kontext. Výsledkem je téma, konkrétní důvod, požadavek, výsledek hovoru, souhrn a sentiment odhadnutý z textu. Přepis zůstává k dispozici při selhání analýzy. Pro provoz s citlivými daty a účtovaným API zajistěte přístup k webu vhodným přihlášením před reverzní proxy.

Pokud importujete samotné WAV, nastavte také `WHISPER_URL` na [službu whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) s vícejazyčným modelem a podporou `verbose_json`. Jazyk nastavíte pomocí `WHISPER_LANGUAGE`, výchozí je čeština. Aplikace posílá zvuk do nastavené služby Whisper a text do poskytovatele analýzy.

[OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs) · [Gemini](https://ai.google.dev/gemini-api/docs/openai) · [xAI](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) · [Groq](https://console.groq.com/docs/structured-outputs) · [Ollama](https://docs.ollama.com/capabilities/structured-outputs)

## Data pro reporty

Mapa důvodů volání umožňuje rozbalit témata, vidět četnost důvodů a požadavků a otevřít přesný výběr hovorů. Četnosti vycházejí z uložených výsledků. Shodné popisky se slučují bez ohledu na velikost písmen, diakritiku a interpunkci.

`GET /api/report` poskytuje časovou řadu, pokrytí, srovnání a mapu. `GET /api/calls` poskytuje seznam a stránkování. `GET /api/calls/<key>` poskytuje detail. `GET /api/export.csv` exportuje hovory, volitelně s přepisy při `includeTranscript=1`. `GET /api/export/report.csv` exportuje souhrn za aktuální období včetně počtů podle témat, důvodů a požadavků. Filtry zahrnují `dataset`, `from`, `to`, `branch`, `topic`, `sentiment`, `q` a výběr z mapy pomocí `labelType` a `label`.

## Ověření

```powershell
node --test
```

Testy ověřují ruční import, mapování CSV, doplnění WAV, agregace v reportu a integrace se simulovanými odpověďmi poskytovatelů. Test VoIPmonitoru používá simulovanou instalaci včetně rozšířeného CDR API.
