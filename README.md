# Master of Tales Bridge

A Foundry VTT module that pipes what happens at your table — rolls, chat, combat, hit
points, conditions, loot and scene changes — into a live
[Master of Tales](https://masteroftales.com) session log, and holds a connection open for
commands coming back the other way.

Foundry v13 and v14. System-agnostic: a Pathfinder, Savage Worlds or homebrew table gets a
working log on day one. dnd5e gets extra detail on top, never instead.

This repository is public on purpose. You are about to paste a credential into it, and you
deserve to be able to read what it does with that credential.

## Install

In Foundry: **Add-on Modules → Install Module**, and paste this manifest URL:

```
https://masteroftales.com/foundry/module.json
```

(That URL redirects to the current GitHub release. If you would rather pin to GitHub
directly, use `https://github.com/jchinkle/masteroftales-foundry-bridge/releases/latest/download/module.json`.)

Then enable the module in your world.

## Setup

1. In Master of Tales, open your project's **Settings → Bridge keys** and create a key.
   It starts with `mtb_` and is shown **once** — copy it now.
2. In Foundry, open **Configure Settings → Module Settings → Master of Tales Bridge**.
3. Leave **Master of Tales server** as `https://masteroftales.com` unless you self-host.
4. Paste the key into **Bridge API token**.
5. Click **Test connection**. You should see your project's name and whether a session is
   live.

A small status chip appears near the player list:

| | |
| --- | --- |
| 🟢 **Logging to _Session 14_** | Connected, a session is live, events are being written |
| 🟡 **No live session** | Connected and healthy — start a session in MoT and rolls begin logging |
| ⚪ **Offline** | Not connected. This is normal when MoT is unreachable or unconfigured |
| 🔴 **Token rejected** | The key is wrong or was revoked. Paste a new one |

Clicking the chip re-runs the connection test.

Only the **active GM's** browser does any of this. Foundry designates exactly one active GM
even when two are logged in, so events are never sent twice, and players' clients do
nothing at all.

## What data flows where

**Foundry → Master of Tales** (an HTTPS POST every 250ms or 20 events, whichever comes
first):

- **Rolls** — the formula, the total, each die's faces and results (including which were
  discarded by advantage/keep-highest), the flavor text, and who rolled it.
- **Chat messages** — the text with HTML stripped, who said it, and whether it was a
  whisper.
- **Combat** — when a fight starts, who was in it, whose turn it is each round, and how
  many rounds it lasted.
- **Actors** — a token appearing on the scene, hit points changing (for player characters
  *and* for unlinked tokens, which is where every mook keeps its HP), conditions arriving
  and lifting, and anything marked defeated.
- **Loot** — items gained and lost by a character, with quantity and rarity where the
  system publishes them, and coin changing hands.
- **Scenes** — the party arriving somewhere new, which is what the log's chapter headings
  are made of.
- **Bridge identity** on each batch — your world id, Foundry version, game system and
  version, and this module's version. That is what lets the MoT panel say "last seen 3
  minutes ago, dnd5e 5.0.2".
- **Your actor list**, when Master of Tales asks for it — and once when your world loads.
  Each actor's id, name, portrait path and system type (`npc`, `character`…), capped at 500,
  and nothing else: no sheet, no hit points, no inventory, no ownership. It exists so that
  planning "three goblins and a bugbear" in Master of Tales can point at *your* goblins
  rather than at a name typed from memory. This is the one thing the module reads that is
  not a document changing during play; it is a directory listing, and it is sent only when
  asked for and once at startup.
- **Who is at the table**, alongside that identity — each Foundry user's id, display name,
  whether they are a GM, and whether their browser is connected right now. Nothing else
  about them: no email, no password, no character sheet, no permissions, no IP. It exists
  so that "show this image to Robin" has a Robin to point at. It is also sent on its own,
  with no events attached, every 30 seconds while connected — otherwise the list in the MoT
  panel would be as stale as the last roll of the night, and a quiet table is exactly when
  you go looking for it.

Everything above is read from Foundry's **core document hooks**, which every game system
goes through. dnd5e worlds get extra detail attached alongside — advantage and
disadvantage on a d20, temporary hit points, coin denominations — and no server logic ever
depends on it, so a Pathfinder or homebrew table gets the same log with plainer lines.

**Whispers and private rolls are captured by default.** On the server they are recorded so
that only editor-and-above members of the project can see them — a player-role member never
receives them. The reasoning: the log you didn't capture is not recoverable, and the log you
captured too much of is a filter setting.

### What stays GM-only

Everything captured is visible to the whole project except two things, both marked private
and recorded as GM-only in Master of Tales — the same treatment a whisper gets.

**Anything from a hidden token.** A hidden token appearing, taking damage or gaining a
condition, and a hidden combatant's turn are all yours alone. Un-hide the token and
everything from that moment on is logged normally. Hiding a token is the one thing in
Foundry that means, unambiguously, *the players cannot see this*, so if you want the ambush
kept out of the shared log, hide the token — which is what you were going to do anyway.

**Loot belonging to an actor no player owns.** Items and coin gained or lost by a
GM-controlled NPC stay yours, even while the fight itself is logged in full. The reasoning
is the difference between the two kinds of event: hit points and conditions are things the
table *watched happen* — a monster being bloodied is public precisely because everyone saw
it land — whereas an inventory is read off a sheet nobody else may open. Your players'
own characters' loot is public as normal, and an actor whose ownership the module cannot
read is treated as the GM's.

**And the token itself.** It is stored in the GM's browser and nowhere else (see *About the
token*), which makes one thing structural rather than a promise: the handout fetch — the
one request this module makes *for* your project's writing rather than about your table —
can only ever run on the GM's client. A player's browser has no key to make it with, and
the content it brings back is the version Master of Tales already stripped for players.

### Turning families off

**Capture toggles live in Master of Tales, not here.** Per-family switches — combat,
actors, loot, scenes, chat, rolls — are in your project's settings panel, and the server
simply does not record what you switched off. There is no second set of switches in the
module, on purpose: two controls for one behaviour is a support conversation that starts
with "but I turned it off", and only the server end can change its mind about a family
without asking you to update a module.

**Master of Tales → Foundry** (a WebSocket the module dials **out** to MoT — nothing ever
connects *in* to your Foundry, and no port needs opening):

- **Session state** — the current session's name and whether it is live, so the chip can
  say so.
- **Dice** — a roll made in Master of Tales appears in Foundry as a real, already-resolved
  roll showing the faces MoT rolled. It is a genuine Foundry roll rather than a picture of
  one, so **Dice So Nice animates it on every player's screen** if you have that module,
  and the chat card reads like any other roll. The total is the one MoT computed.
- **Announcements** — a note marked *announce* in Master of Tales appears in Foundry chat
  under the name MoT gave it. It is posted as **text, never as markup**: a note containing
  `<b>` reads as `<b>` at the table.
- **Images** — a map, a portrait or a handout shown from Master of Tales opens as an image
  window on the screens you picked: everybody, or one player, or three. It is an ordinary
  Foundry image popout, and the picture is loaded straight from the URL MoT sent, which may
  be a MoT upload or a path to a file already in your own Foundry. Only `http(s)` and
  in-Foundry paths are accepted; anything else is refused unopened.
- **Handouts** — a page shown from Master of Tales arrives in Foundry as a **journal
  entry**, filed in a folder called *Master of Tales*, and opens on the screens you picked.
  This is the one direction in which your own writing travels *into* Foundry, and only the
  **player-safe version of it**: Master of Tales strips whatever the page keeps back from
  players before it sends a word, and the module has no way to ask for the rest. Showing
  the same page again **updates the same entry in place** rather than making a second one,
  so your players keep the letter between sessions and can reopen it from their sidebar
  whenever they like. Paper and ink do not travel with it: a Foundry journal wears
  Foundry's look, honestly, rather than a pastiche of MoT's.
- **Encounters** — a fight you planned in Master of Tales, deployed a stage at a time.
  Pressing **Deploy** on a stage opens a small **token tray** on your screen listing that
  stage's monsters — three goblins, a bugbear — and you drag each one onto the map. *You*
  place them, because where an ambush stands is the one part of an encounter that is
  entirely about the picture on the screen, and each row drags exactly as a drag from your
  own actor directory does, so prototype tokens, vision and your system's hooks all behave
  as they always do. Once every token is down, the module makes sure a combat exists on
  that scene, adds the new tokens to it, and asks **Foundry** to roll initiative for them.
  It never invents an initiative number: your game system rolls it, the same way it does
  for a token you drop by hand. Anyone already in the fight keeps the initiative they
  rolled — deploying reinforcements in round three does not reshuffle your table. And you
  are not obliged to finish: the roll button stays pressable, so four of six goblins is a
  decision rather than a trap. A row Master of Tales never linked to a Foundry actor — or
  one pointing at an actor this world no longer has — appears in the tray greyed, with a
  line saying why, rather than quietly going missing.
- **New creatures** — a creature you invented in Master of Tales can be sent straight into
  this world as a real Foundry actor, token art and all. The picture travels as **bytes,
  once**, and is written into your own Foundry's data folder — a directory called
  `masteroftales-tokens`, made on first use — rather than linked back to Master of Tales.
  That is the whole point of doing it the slow way: from the moment it lands it is an
  ordinary Foundry actor wearing an ordinary local picture, and it keeps working with Master
  of Tales shut, your internet down, or your subscription cancelled. A picture whose name is
  already taken is saved under a new one; nothing in that folder is ever overwritten, and no
  file outside it is ever written at all. The actor is created as your system's `npc` type
  where it has one, and its portrait and its prototype token both point at the new file.
  Foundry's own id and name for it travel back so Master of Tales can point its page at
  *your* actor — and that is the entirety of what goes back. If any step fails, nothing is
  reported and Foundry says why on your screen.
- **A single token** — a creature this world already has, put on the map you are currently
  looking at, centred in your view. This is the encounter tray with the encounter taken out
  of it: one token, **no combat, no initiative, no tracker**, for the evenings when you just
  want the shopkeeper on the screen. The token is built from *your* prototype token — its
  size, vision, disposition and link are the ones you configured — and it lands on the map
  in front of **you**, never on the players' active scene, which is the difference that
  matters when you are setting the next room up before revealing it. If you picked a piece
  of token art in Master of Tales it travels the same way a new creature's does, into the
  same `masteroftales-tokens` folder, and it dresses **that one token**: your actor's own
  portrait and prototype are left exactly as you set them. Nothing goes back to Master of
  Tales — the token appearing is the answer — and if there is no scene open, or the creature
  is not in this world, nothing is placed and Foundry says why on your screen.

Dice and announcements are created by the **active GM's client only**, so the table sees
one message rather than one per open browser, and both carry a flag that stops this module
capturing its own output — a roll MoT sent you does not come back as a second entry in
your log.

Images are the exception, and the reason this module asks Foundry for socket access: a
chat message is a *document*, which Foundry copies to every client by itself, but an image
window is not. So the GM's client passes the command on to the targeted players' clients
over Foundry's own connection — the same one Foundry uses for everything else, never a new
one, and never anything leaving your network. Each client then decides for itself whether
it was one of the people asked for.

Handouts need none of that, and the difference is worth a sentence: a journal entry *is* a
document, so once the GM's client has written it Foundry copies it to the players it is
shared with by itself. The GM's client is the only one that fetches anything, because it is
the only one holding a token — see below.

Encounters need less again. The tray is a window on the GM's own screen, and nothing about
it reaches a player until a token is on the map — at which point it is an ordinary Foundry
token, and combat, initiative and the tracker are Foundry's from there on.

Placing a single token needs less still: it is one document written to the scene already
open on the GM's screen, and Foundry replicates it to the table exactly as it does a token
dropped by hand.

Carrying a picture is the only thing that writes a **file**, and it is worth being exact
about which one: a single image, under `masteroftales-tokens/` in your world's data, named
after the creature, created by the GM's client through Foundry's own upload. Two commands do
it — creating a creature and placing a token wearing art you picked — and they write into
that same one directory and nowhere else. Nothing is read back out of it except the list of
names already in it, which is how a second bugbear avoids overwriting the first. No other
file, anywhere on your machine, is written or read.

Anything else MoT may send is ignored quietly: a server that has shipped a feature your
module has not costs you the feature, never the connection.

Nothing else is read or sent. The module reads documents **only as they change**, through
the hooks listed above, and it never sends anything anywhere except the server URL you
configured. It walks your world in exactly one place — the actor list described above, which
is ids, names, portrait paths and types, and never a sheet. Your compendia are not read at
all, and the only files it touches are the token pictures it writes for creatures you asked
it to create or to place — one directory, described above, never read back and never sent
anywhere.
Your journals are read only far enough to find the handout entries this
module wrote before, by a flag it stamped on them — their contents are never sent anywhere.
A portrait travels as a **link back to your own Foundry** — its address and route prefix in
front of the path Foundry stores — rather than as a picture. The file stays on your machine
and only the browser you are picking monsters in ever asks for it, which is also why a
Foundry that is shut is simply a list with no portraits in it that evening. Beyond that
listing, actors, tokens and scenes are read only at the moment one of them
changes during play,
and only for the handful of fields named above (name, image, hit points, conditions,
disposition, coin). Character sheets are not uploaded, and neither is anything you have not
touched.

## About the token

**The token is stored per-client — on the GM's machine only, not in the world.**

This matters. Foundry's world-scoped settings are readable from *every* player's browser
console. A world-scoped credential is a credential you have handed to the table. So this
module registers the token with `scope: "client"`, and it stays in the browser of whoever
typed it. If two people GM your world, each pastes the key on their own machine.

**If a player did somehow obtain the key**, here is the whole of what they could do with it:

- Post fake entries into that one project's **live** session log.
- Receive that project's command stream — session state, mirrored dice and announcements
  now, music cues later.
- Make a roll or a chat message appear in the Foundry world of anyone connected with a key
  for the *same* project. It arrives as an ordinary chat message under whatever name was
  given, it cannot contain markup or a script, and it changes nothing in your world.
- Open an image window on those same people's screens, and read the list of who is logged
  in to that world (display names only). The image is loaded as a picture and nothing else
  — the URL must be `http(s)` or a path inside that Foundry, and a `javascript:` or `data:`
  one is refused before it reaches the browser.
- Read the **player-safe text of that project's shared pages**, one at a time and by id, and
  cause one of them to be written into the journal of a Foundry connected with a key for the
  same project. Not the pages themselves — only what that project already lets its players
  read, and nothing at all from a page that has not been shared.
- Ask that Foundry for its **actor list** — ids, names, portrait paths and system types, and
  none of the sheets behind them — and open a **token tray** on the GM's screen with a list
  of monsters in it. Nothing lands on a map from the tray unless the GM drags it there, and
  the only thing that follows from a placement is Foundry's own initiative roll for the token
  just placed.
- Create an actor in that world, and **put one token on the scene the GM is looking at** —
  each carrying a picture, which is written into the `masteroftales-tokens` folder described
  above and nowhere else. A placed token is an ordinary token: it starts no combat, rolls
  nothing, and changes no document that was already there. Both are as undoable as anything
  else in Foundry — delete the token, delete the actor — and neither can touch a scene the
  GM is not looking at.

And that is the list. An `mtb_` key cannot read your documents, cannot see your assets,
cannot touch any other project, and does not identify you as a user anywhere. This is
deliberate — Master of Tales has ordinary API keys that can do those things, and the bridge
pointedly does not use them, because the blast radius of a credential living in a Foundry
settings pane has to be smaller than the mistake.

You can revoke a bridge key at any time from your project settings. The module will notice
and show **Token rejected** rather than retrying.

### Why https is required

The server URL must be `https://` (`http://localhost` is allowed for local development).
A Foundry served over https cannot open an insecure connection to anything — the browser
blocks it as mixed content, silently, in a way the module cannot detect. Rejecting the URL
up front turns a baffling silent failure into one sentence.

## Development

```bash
npm install
npm test        # vitest, against hand-written Foundry stubs — no Foundry required
npm run build   # -> dist/main.js, the ESM bundle module.json points at
npm run check   # typecheck + test + build
```

There are no runtime dependencies, and the dev toolchain is typescript, vite and vitest —
nothing else. The ActionCable client protocol is implemented by hand (it is six message
types) rather than pulled in as a package.

The design keeps everything with a decision in it — batching, backoff, the cable state
machine, roll serialisation, the loop guard, HTML stripping, and every capture — in pure
functions with unit tests, and keeps the Foundry-touching layer thin enough to read in one
sitting. Each capture family is one file in `src/capture/` whose hook handlers do nothing
but check the activation gate and hand the document to a pure builder, so a test can feed
in a v13-shaped document, a v14-shaped one, or a half-deleted one and assert the exact
envelope that comes out.

The commands coming the other way are built the same way. `src/commands/` turns a payload
into a *plan* — a validated, escaped, Foundry-free value — and only then hands the plan to
the handful of Foundry classes it needs, which are looked up by feature detection so the
same bundle works on v13 and v14. A malformed command drops calmly at debug volume rather than
throwing, because a command that cannot be rendered should cost you an animation, not the
socket that tells the chip a session went live.

Two rules the capture layer holds to, both of which show up all over the tests:

- **Absent over wrong.** Every reader returns null rather than a guess. A missing field is
  a shorter sentence in somebody's log; a wrong one is a sentence that lies.
- **Idempotency keys never contain a clock reading.** They are built from Foundry's own
  document ids and `_stats.modifiedTime`, so an outbox replayed after a reconnect mints the
  same keys and the server answers `duplicate` instead of writing the night twice.

Releases are cut by pushing a `v*` tag. CI runs the full suite on every push and pull
request, and the release workflow will not package or publish anything unless the suite
passes.

## License

MIT — see [LICENSE](./LICENSE).
