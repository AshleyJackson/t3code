# Factory Droid

Install and authenticate the Factory Droid CLI on the machine running your
environment, then enable **Droid** in **Settings > Providers**. T3 Code uses the
provider's SDK session, so the Droid CLI and its credentials must be available to
that environment.

T3 Code discovers the models available to your Droid account. If discovery is
unavailable, the model picker keeps a **Factory default** option so you can still
try the provider. Set **Binary path** when `droid` is not on the server's `PATH`.

## Access levels

Droid exposes its autonomy levels through the composer access menu:

- **Off** asks before every action.
- **Low** allows file edits and read-only commands.
- **Medium** allows reversible commands.
- **High** allows all Droid actions without prompts.

Use **Plan** mode when you want Droid to research and propose a plan before
implementation.

## Images

Attach PNG, JPEG, GIF, or WebP images to a Droid prompt. Other attachment types
are not supported by Droid.
