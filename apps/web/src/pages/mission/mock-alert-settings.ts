import { AlertSettingsSchema, type AlertSettings } from '@eko/shared';
import { MOCKS } from '../../lib/api';

// Page-local demo state survives route changes, without enabling notifications.
// Keep the other mocked alert preferences when either delivery switch changes.
export function createMockAlertSettings(initial: AlertSettings) {
  let settings = AlertSettingsSchema.parse(initial);
  return {
    read: () => structuredClone(settings),
    save: (channel: 'push' | 'telegram', enabled: boolean) => {
      settings = AlertSettingsSchema.parse({ ...settings, [channel]: enabled });
      return structuredClone(settings);
    },
  };
}
let session: Promise<ReturnType<typeof createMockAlertSettings>> | undefined;
export function loadMockAlertSettings() {
  if (!MOCKS) throw new Error('Mock alert settings require demo mode.');
  return session ??= import('../../mocks/fixtures').then(({ createAlertSettings }) => createMockAlertSettings(createAlertSettings()));
}
