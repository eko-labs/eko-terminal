import { defineConfig } from '@playwright/test';
const api=Number(process.env.E2E_API_PORT ?? 8730),web=Number(process.env.E2E_WEB_PORT ?? 5193);
export default defineConfig({
  testDir:'./e2e',testMatch:'v1-reads.spec.ts',workers:1,timeout:60000,
  use:{baseURL:`http://127.0.0.1:${web}`,channel:process.env.PW_CHANNEL ?? 'chrome',trace:'retain-on-failure'},
  projects:[{name:'reads-desktop',use:{viewport:{width:1440,height:900}}},{name:'reads-mobile',use:{viewport:{width:390,height:844}}}],
  webServer:[
    {command:'pnpm --filter @eko/server exec tsx test/read-e2e-server.ts',cwd:'../..',port:api,reuseExistingServer:false,
      env:{PORT:String(api),PUBLIC_ORIGIN:`http://127.0.0.1:${web}`,PGLITE_DIR:':memory:',NODE_ENV:'test',SESSION_SECRET:'e2e-test-placeholder'.repeat(3),MARKET_DATA_SOURCE:'onchain',RUN_WORKER:'false',LOG_LEVEL:'error'}},
    {command:`pnpm exec vite --host 127.0.0.1 --port ${web} --strictPort`,port:web,reuseExistingServer:false,
      env:{EKO_API:`http://127.0.0.1:${api}`,VITE_MOCKS:'0',VITE_API_URL:'/v1'}},
  ],
});
