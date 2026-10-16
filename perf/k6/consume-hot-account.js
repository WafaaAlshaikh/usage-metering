import { createFixtures, consumeOnce, summarize} from './lib.js';

export const options = {
  scenarios: {
    hot: { executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || '30s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
    'http_req_duration{name:consume}': ['p(95)<5000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return createFixtures({ accounts: 1, users: 20 });
}

export default function (fixtures) {
  consumeOnce(fixtures[0], __VU);
}

export function handleSummary(data) {
  return summarize(data, __ENV.RESULT || 'hot-account');
}

