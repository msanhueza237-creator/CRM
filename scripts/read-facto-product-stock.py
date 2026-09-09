"""Read-only inventory diagnosis inside the existing hub container. No CRM/ERP writes."""
import asyncio
import json
import sys
from app.config import Settings
from app.integrations.facto import FactoClient, FactoError


async def main():
    client = FactoClient(Settings())
    records, failures = [], []
    ids = json.loads(sys.argv[1])
    for index, product_id in enumerate(ids):
        if not str(product_id).isdigit():
            raise ValueError("Expected numeric product IDs")
        for attempt in range(3):
            try:
                data = await client.product(product_id)
                for _ in range(4):
                    if not isinstance(data, dict):
                        break
                    nested = next((data[key] for key in ['data', 'product', 'item', 'result'] if isinstance(data.get(key), dict)), None)
                    if nested is None:
                        break
                    data = nested
                if not isinstance(data, dict) or str(data.get('product_id')) != str(product_id):
                    raise ValueError('Product identity mismatch')
                # Only public catalog fields; no credentials, costs or customer data.
                safe = {key: data.get(key) for key in ['product_id', 'sku', 'name', 'inventories', 'price']}
                records.append({'external_id': str(product_id), 'payload': safe})
                break
            except (FactoError, ValueError) as exc:
                if attempt == 2:
                    failures.append({'id': product_id, 'reason': str(exc)})
                else:
                    await asyncio.sleep(3 * (attempt + 1))
        if (index + 1) % 25 == 0:
            print(f'Read {index + 1}/{len(ids)}; failures {len(failures)}', file=sys.stderr)
        await asyncio.sleep(0.25)
    print(json.dumps({'records': records, 'failures': failures}))


asyncio.run(main())
