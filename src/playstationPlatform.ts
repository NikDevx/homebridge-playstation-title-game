import {
  API,
  Logger,
  PlatformConfig,
  Service,
  Characteristic,
  IndependentPlatformPlugin,
} from "homebridge";

import fs from 'fs';
import path from 'path';

import { PlaystationAccessory } from "./playstationAccessory";
import { Discovery } from "playactor/dist/discovery";

export interface PlaystationPlatformConfig extends PlatformConfig {
  pollInterval?: number;
  PSNAWP?: string;
  account_id?: Array<{ id: string;}>;
  overrides?: Array<{ deviceId: string; name?: string }>;
  /**
   * Optional per-console settings. Lets each console show the game of its own
   * PSN account(s) instead of every console sharing the global `account_id` list.
   */
  devices?: Array<{ deviceId: string; name?: string; account_id?: Array<{ id: string }> }>;
  /** When true, consoles that are not listed in `devices` are ignored. */
  onlyConfiguredDevices?: boolean;
  apps?: Array<{ id: string; name: string }>;
}

export class PlaystationPlatform implements IndependentPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly kDefaultPollInterval = 15_000;

  constructor(
    public readonly log: Logger,
    public readonly config: PlaystationPlatformConfig,
    public readonly api: API
  ) {
    const dataFilePath = path.join(this.api.user.storagePath(), 'homebridge_psn_data.json');

    try {
        if (!fs.existsSync(dataFilePath)) {
            fs.writeFileSync(dataFilePath, '{}', { encoding: 'utf8', mode: 0o666 });
            this.log.info(`[⚠️] Created dynamic PSN data file at: ${dataFilePath}`);
        } else {
            fs.chmodSync(dataFilePath, 0o666);
        }
    } catch (err) {
        this.log.error(`Failed to set up PSN data file: ${(err as Error).message}`);
    }

    this.log.debug("Config", config);
    this.log.info("Discovering devices...");

    this.discoverDevices().catch((err) => {
      this.log.error((err as Error).message);
    });
  }

  async discoverDevices() {
    const discovery = new Discovery();
    const devices = discovery.discover();
    const seenDeviceIds = new Set<string>();

    for await (const deviceInformation of devices) {
      this.log.debug("Discovered device:", deviceInformation);

      // Discovery can report the same console several times (e.g. while it
      // changes state); creating a second accessory for the same id would
      // publish a duplicate external accessory.
      if (seenDeviceIds.has(deviceInformation.id)) {
        this.log.debug(`Skipping already registered device ${deviceInformation.id}`);
        continue;
      }

      if (this.config.onlyConfiguredDevices &&
        !this.config.devices?.some((d) => d.deviceId === deviceInformation.id)) {
        this.log.info(
          `Ignoring device ${deviceInformation.id} (${deviceInformation.name}) - not listed in "devices".`,
        );
        continue;
      }

      seenDeviceIds.add(deviceInformation.id);
      new PlaystationAccessory(this, deviceInformation);
    }
  }
}