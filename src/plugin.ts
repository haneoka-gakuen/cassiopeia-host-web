import { defineCassiopeiaPlugin, defineCassiopeiaService } from "@haneoka/cassiopeia/plugin";
import { MediaClock } from "./audio/MediaClock";
import { NoteSoundPlayer } from "./audio/NoteSoundPlayer";
import { OurNotesInput } from "./input/OurNotesInput";
export const WEB_HOST = defineCassiopeiaService<{
  createClock(...args: ConstructorParameters<typeof MediaClock>): MediaClock;
  createNoteSounds(...args: ConstructorParameters<typeof NoteSoundPlayer>): NoteSoundPlayer;
  createInput(...args: ConstructorParameters<typeof OurNotesInput>): OurNotesInput;
}>("cassiopeia.host-web.v1");
export function createWebHostPlugin() {
  return defineCassiopeiaPlugin({
    manifest: {
      id: "cassiopeia.host-web",
      version: "0.1.0",
      apiVersion: 1,
      requires: ["cassiopeia.our-notes"],
      provides: [WEB_HOST.id],
    },
    setup(context) {
      context.provide(WEB_HOST, {
        createClock: (...args) => new MediaClock(...args),
        createNoteSounds: (...args) => new NoteSoundPlayer(...args),
        createInput: (...args) => new OurNotesInput(...args),
      });
    },
  });
}
