import {
    API,
    Characteristic,
    CharacteristicValue,
    PlatformAccessory,
    Service,
} from 'homebridge';
import path from 'path';

import {Device} from 'playactor/dist/device';
import {DeviceStatus, IDiscoveredDevice} from 'playactor/dist/discovery/model';

import {PlaystationPlatform} from './playstationPlatform';
import {PLUGIN_NAME} from './settings';
import {spawn} from 'child_process';

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), ms);
        promise.then((val) => {
            clearTimeout(timer);
            resolve(val);
        }).catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

export class PlaystationAccessory {
    private readonly accessory: PlatformAccessory;
    private readonly tvService: Service;
    private readonly api: API = this.platform.api;
    private readonly Service: typeof Service = this.platform.Service;
    private readonly Characteristic: typeof Characteristic = this.platform.Characteristic;

    private lockUpdate = false;
    private lockSetOn = false;
    private tick: NodeJS.Timeout | undefined;
    private lockTimeout: NodeJS.Timeout | undefined;
    private readonly kLockTimeout = 20_000;

    private titleIDs: string[] = [];
    private dynamicTitleSource: Service | null = null;
    private titleUpdateInterval: NodeJS.Timeout | null = null;
    private lastTitle: string | null = null;

    constructor(
        private readonly platform: PlaystationPlatform,
        private deviceInformation: IDiscoveredDevice,
    ) {
        const uuid = this.api.hap.uuid.generate(deviceInformation.id);
        const override = this.platform.config.overrides?.find(
            (o) => o.deviceId === deviceInformation.id
        );

        const deviceName = override?.name || this.platform.config.name || 'PlayStation';

        this.accessory = new this.api.platformAccessory(deviceName, uuid);
        this.accessory.category = this.api.hap.Categories.TV_SET_TOP_BOX;

        this.accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Name, deviceName)
            .setCharacteristic(this.Characteristic.Manufacturer, 'Sony')
            .setCharacteristic(this.Characteristic.Model, deviceInformation.type)
            .setCharacteristic(this.Characteristic.SerialNumber, deviceInformation.id)
            .setCharacteristic(this.Characteristic.FirmwareRevision, deviceInformation.systemVersion);

        this.tvService =
            this.accessory.getService(this.Service.Television) ||
            this.accessory.addService(this.Service.Television);

        this.tvService.setCharacteristic(this.Characteristic.Name, deviceName);
        this.tvService.setCharacteristic(this.Characteristic.ConfiguredName, deviceName);

        this.tvService.getCharacteristic(this.Characteristic.ConfiguredName).updateValue(deviceName);
        this.tvService.getCharacteristic(this.Characteristic.Name).updateValue(deviceName);

        this.tvService.setCharacteristic(
            this.Characteristic.SleepDiscoveryMode,
            this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
        );

        this.tvService.getCharacteristic(this.Characteristic.Active)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));

        this.tvService.getCharacteristic(this.Characteristic.RemoteKey)
            .onSet((newValue: CharacteristicValue) => {
                this.platform.log.debug(`[${this.deviceInformation.id}] RemoteKey not implemented`, newValue);
            });

        this.tvService.setCharacteristic(this.Characteristic.ActiveIdentifier, 0);

        this.addTitle('PSAXXXX', 'Loading', 0);
        this.startTitleUpdateLoop();
        this.updateGameTitleNow();

        this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier)
            .onSet(this.setTitleSwitchState.bind(this));

        this.tick = setInterval(
            this.updateDeviceInformations.bind(this),
            this.platform.config.pollInterval || 120000,
        );

        this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
    }

    private addTitle(titleId: string, titleName: string, index: number) {
        const titleInputSource = new this.Service.InputSource(titleName, titleId);
        titleInputSource
            .setCharacteristic(this.Characteristic.Identifier, index)
            .setCharacteristic(this.Characteristic.Name, titleName)
            .setCharacteristic(this.Characteristic.ConfiguredName, titleName)
            .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
            .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.APPLICATION)
            .setCharacteristic(this.Characteristic.CurrentVisibilityState, this.Characteristic.CurrentVisibilityState.HIDDEN);

        this.accessory.addService(titleInputSource);
        this.tvService.addLinkedService(titleInputSource);
        this.titleIDs.push(titleId);
        this.dynamicTitleSource = titleInputSource;
    }

    private startTitleUpdateLoop() {
        const polling = this.platform.config.pollInterval || 120000;

        if (this.titleUpdateInterval) clearInterval(this.titleUpdateInterval);

        this.titleUpdateInterval = setInterval(() => {
            this.fetchAndSetTitle();
        }, polling);
    }

    private updateGameTitleNow() {
        this.fetchAndSetTitle();
    }

    private fetchAndSetTitle() {
        const PSNAWP = this.platform.config.PSNAWP || '';
        const account_ids: string[] = (this.platform.config.account_id || []).map((acc) => acc.id);
        const scriptPath = path.join(__dirname, 'title_game.py');
        const dataFilePath = path.join(this.platform.api.user.storagePath(), 'homebridge_psn_data.json');
        const get_title = spawn('python3', [scriptPath, PSNAWP, JSON.stringify(account_ids), dataFilePath]);

        let output = '';

        get_title.stdout.on('data', (data) => {
            output += data.toString();
        });

        get_title.on('close', (code) => {
            get_title.removeAllListeners();

            if (code !== 0) {
                this.platform.log.debug(`Python script exited with code ${code}`);
                return;
            }

            const newTitle = output.trim();
            if (!newTitle || newTitle.length === 0) return;

            if (
                newTitle.toLowerCase().includes('error') ||
                newTitle.includes('{') ||
                newTitle.includes('database is locked') ||
                newTitle.includes('temporarily_unavailable')
            ) {
                this.platform.log.debug(`🔇 Ignored bad title output: ${newTitle}`);
                return;
            }

            if (newTitle !== this.lastTitle && this.dynamicTitleSource) {
                this.lastTitle = newTitle;
                this.platform.log.info(`🎮 PSN Title Updated: ${newTitle}`);

                const safeTitle = newTitle.substring(0, 63);

                this.dynamicTitleSource
                    .setCharacteristic(this.Characteristic.Name, safeTitle)
                    .setCharacteristic(this.Characteristic.ConfiguredName, safeTitle);
            }
        });

        get_title.on('error', (err) => {
            this.platform.log.error(`Failed to start python script: ${err.message}`);
            get_title.removeAllListeners();
        });
    }

    private async discoverDevice() {
        const device = Device.withId(this.deviceInformation.id);
        this.deviceInformation = await device.discover();
        return device;
    }

    private async getOn(): Promise<CharacteristicValue> {
        return this.deviceInformation.status === DeviceStatus.AWAKE;
    }

    private setOn(value: CharacteristicValue): void {
        if (this.lockSetOn) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        }

        this.addLocks();

        this.tvService
            .getCharacteristic(this.Characteristic.Active)
            .updateValue(value);

        void (async () => {
            try {
                const device = await this.discoverDevice();
                const currentStatus = this.deviceInformation.status;
                const desiredStatus = value ? DeviceStatus.AWAKE : DeviceStatus.STANDBY;

                if (currentStatus === desiredStatus) {
                    this.platform.log.debug(`[${this.deviceInformation.id}] Already in desired state`);
                    return;
                }

                try {
                    const connection = await device.openConnection();

                    if (value) {
                        this.platform.log.debug(`[${this.deviceInformation.id}] 🆙 Waking device...`);
                        await timeout(device.wake(), 15_000);
                    } else {
                        this.platform.log.info(`[${this.deviceInformation.id}] 💤 Sending standby command...`);

                        await timeout(connection.standby(), 15_000);
                    }

                    await connection.close();
                } catch (err) {
                    const message = (err as Error).message;

                    if (!value && message.includes('403') && message.includes('Remote is already in use')) {
                        this.platform.log.warn(`[${this.deviceInformation.id}] Remote already in use — assuming console already in standby.`);
                        await this.updateDeviceInformations(true);
                        return;
                    }

                    throw err;
                }

            } catch (err) {
                const message = (err as Error).message;
                this.platform.log.error(`[${this.deviceInformation.id}] Background error: ${message}`);
            } finally {
                this.releaseLocks();
                await this.updateDeviceInformations(true);
            }
        })();
    }

    private async setTitleSwitchState(value: CharacteristicValue) {
        const requestedTitle = this.titleIDs[value as number] || null;
        if (!requestedTitle) return;

        if (this.lockSetOn) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        }

        this.addLocks();

        try {
            if (this.deviceInformation.status !== DeviceStatus.AWAKE) {
                this.platform.log.warn(`[${this.deviceInformation.id}] Console not awake. Cannot start title.`);
                return;
            }

            const device = await this.discoverDevice();

            if (this.deviceInformation.extras['running-app-titleid'] === requestedTitle) return;

            const connection = await device.openConnection();
            await connection.startTitleId?.(requestedTitle);
            await connection.close();
        } catch (err) {
            this.platform.log.error((err as Error).message);
        } finally {
            this.releaseLocks();
        }
    }

    private async updateDeviceInformations(force = false) {
        if (this.lockUpdate && !force) return;

        this.lockUpdate = true;

        try {
            await this.discoverDevice();
        } catch {
            this.deviceInformation.status = DeviceStatus.STANDBY;
        } finally {
            this.lockUpdate = false;
            this.tvService
                .getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.deviceInformation.status === DeviceStatus.AWAKE);
        }
    }

    private addLocks() {
        this.lockSetOn = true;
        this.lockUpdate = true;
        this.lockTimeout = setTimeout(() => {
            this.releaseLocks();
        }, this.kLockTimeout);
    }

    private releaseLocks() {
        this.lockSetOn = false;
        this.lockUpdate = false;
        if (this.lockTimeout) {
            clearTimeout(this.lockTimeout);
        }
    }
}