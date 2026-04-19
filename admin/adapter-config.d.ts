// This file extends the AdapterConfig type from "@types/iobroker"
// using the "native" property from io-package.json

export {};

declare global {
	namespace ioBroker {
		interface AdapterConfig {
			githubToken: string;
			checkInterval: number;
			autoUpdate: boolean;
			notifyOnUpdate: boolean;
			excludeAdapters: string;
		}
	}
}
