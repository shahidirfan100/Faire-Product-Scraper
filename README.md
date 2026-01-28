# Faire Product Scraper

Extract comprehensive product data from Faire.com with ease. Collect wholesale pricing, brand information, and product details at scale. Perfect for wholesale research, market analysis, and supplier discovery.

## Features

- **Wholesale Pricing Access** — Unlock authenticated wholesale prices with session cookies
- **Complete Product Details** — Extract titles, brands, descriptions, and images
- **Hybrid Scraping Technology** — Combines browser automation with fast HTTP requests
- **Stealth Protection** — Built-in anti-detection measures to bypass bot protections
- **Pagination Support** — Automatically handles infinite scroll and page navigation
- **Proxy Integration** — Residential proxies for reliable data collection

## Use Cases

### Wholesale Supplier Research
Discover new brands and products for your retail business. Access wholesale pricing and contact information to expand your product catalog.

### Market Intelligence
Track wholesale pricing trends across categories. Identify pricing strategies and market opportunities for competitive analysis.

### Product Sourcing
Build comprehensive databases of wholesale products. Filter by category, brand, and pricing to find the best suppliers for your needs.

### Competitive Analysis
Monitor competitor product offerings and pricing. Understand market positioning and identify gaps in product availability.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | Yes | — | Faire category or search URL to start scraping |
| `searchQuery` | String | No | `"candles"` | Product search term when startUrl is not provided |
| `resultsWanted` | Integer | No | `20` | Maximum number of products to collect |
| `cookies` | Array | No | `[]` | Authenticated session cookies for wholesale pricing access |
| `proxyConfiguration` | Object | No | Residential proxy | Proxy settings for bypassing protections |

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Product title |
| `brand` | String | Brand name |
| `brandUrl` | String | Brand profile URL on Faire |
| `productUrl` | String | Product detail page URL |
| `imageUrl` | String | Product image URL |
| `description` | String | Product description (truncated) |
| `wholesalePrice` | String | Wholesale price (requires authentication) |
| `retailPrice` | String | Retail/MSRP price |
| `currency` | String | Currency code (usually USD) |
| `status` | String | Scraping status (Authenticated or Guest) |
| `_scrapedAt` | String | ISO timestamp of when data was collected |

## Usage Examples

### Basic Product Search

Extract products from a search query:

```json
{
    "searchQuery": "handmade candles",
    "resultsWanted": 50
}
```

### Category Scraping

Scrape products from a specific category URL:

```json
{
    "startUrl": "https://www.faire.com/browse?category=jewelry",
    "resultsWanted": 100
}
```

### Wholesale Pricing Access

Unlock wholesale prices with authentication cookies:

```json
{
    "startUrl": "https://www.faire.com/search?q=home-decor",
    "cookies": [
        {"name": "session_id", "value": "your_session_cookie_here"}
    ],
    "resultsWanted": 25
}
```

## Sample Output

```json
{
    "title": "Handcrafted Soy Candle Set",
    "brand": "Artisan Candles Co.",
    "brandUrl": "https://www.faire.com/brand/artisan-candles-co",
    "productUrl": "https://www.faire.com/product/p12345/handcrafted-soy-candle-set",
    "imageUrl": "https://cdn.faire.com/images/product.jpg",
    "description": "Beautiful handcrafted soy candles made with essential oils...",
    "wholesalePrice": "$12.50",
    "retailPrice": "$25.00",
    "currency": "USD",
    "status": "Authenticated/Scraped",
    "_scrapedAt": "2024-01-28T10:30:00.000Z"
}
```

## Tips for Best Results

### Obtaining Authentication Cookies

For wholesale pricing access:
- Log into your Faire account in a browser
- Use browser developer tools or extensions like "EditThisCookie"
- Copy session cookies in JSON format
- Paste into the `cookies` input parameter

### Choosing Start URLs

- Use category pages for broader collection
- Search URLs work well for specific product types
- Verify URLs are accessible before running

### Optimizing Collection Size

- Start with small batches (20-50) for testing
- Increase gradually for production runs
- Balance between speed and data completeness

### Proxy Configuration

For reliable results, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## Integrations

Connect your data with:

- **Google Sheets** — Export for analysis and reporting
- **Airtable** — Build searchable product databases
- **Slack** — Get notifications on scraping completion
- **Webhooks** — Send data to custom endpoints
- **Make** — Create automated workflows
- **Zapier** — Trigger actions based on new data

### Export Formats

Download data in multiple formats:

- **JSON** — For developers and APIs
- **CSV** — For spreadsheet analysis
- **Excel** — For business reporting
- **XML** — For system integrations

## Frequently Asked Questions

### How do I access wholesale prices?
Provide authenticated session cookies from your Faire account in the `cookies` input parameter.

### Can I scrape multiple categories?
Yes, run separate actor instances with different `startUrl` parameters for each category.

### What if I don't have Faire login credentials?
You can still scrape public product information, but wholesale pricing will show as "Unlock wholesale price".

### How many products can I collect?
You can collect all available products. The practical limit depends on the category size and your proxy configuration.

### Does the scraper handle pagination automatically?
Yes, it automatically navigates through pages and infinite scroll to reach your desired result count.

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with Faire's terms of service and applicable laws. Use data responsibly and respect rate limits.