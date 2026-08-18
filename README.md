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

### Turning families off

**Capture toggles live in Master of Tales, not here.** Per-family switches — combat,
actors, loot, scenes, chat, rolls — are in your project's settings panel, and the server
simply does not record what you switched off. There is no second set of switches in the
module, on purpose: two controls for one behaviour is a support conversation that starts
with "but I turned it off", and only the server end can change its mind about a family
without asking you to update a module.

**Master of Tales → Foundry** (a WebSocket the module dials **out** to MoT — nothing ever
connects *in* to your Foundry, and no port needs opening):

- Today: the current session's name and whether it is live, so the chip can say so.
- Later: dice rolled in Master of Tales appearing as real 3D dice on your players' screens.

Nothing else is read or sent. The module reads documents **only as they change**, through
the hooks listed above — it never walks your world, and it never sends anything anywhere
except the server URL you configured. Your journals, compendia and files are not read at
all; actors, tokens and scenes are read only at the moment one of them changes during play,
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
- Receive that project's command stream — session state now, and music cues later.

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
