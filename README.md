# Cassiopeia browser host

Browser-owned audio/media clocks, note sound playback and pointer input.
`createWebHostPlugin()` registers the typed `WEB_HOST` factory service.
It can be used with Lit, Vue, another UI framework, or a plain DOM host.

The caller owns each clock/input/sound player and must stop/dispose it.
Music timestamps, not frame completion timestamps, drive the kernel. Pointer
identities remain stable through gestures. Browser vibration is not synthesized.

```sh
pnpm --filter @haneoka/cassiopeia-host-web check
```

License: MPL-2.0. No renderer or UI framework is bundled.
