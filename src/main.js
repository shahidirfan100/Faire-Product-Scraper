import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load } from 'cheerio';

const DETAIL_PAGE_CONCURRENCY = 5;
const PROCESSED_URLS = new Set();

const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
};

async function main() {
    await Actor.init();

    const input = (await Actor.getInput()) || {};
    log.info('Received Input:', JSON.stringify(input, null, 2));

    let {
        startUrl,
        searchQuery,
        resultsWanted = 20,
        proxyConfiguration: proxyConfig,
        cookies = [],
    } = input;

    // Use Search Query if provided and startUrl is missing
    if (!startUrl && searchQuery) {
        log.info(`No Start URL provided. Using Search Query: ${searchQuery}`);
        startUrl = `https://www.faire.com/search?q=${encodeURIComponent(searchQuery)}`;
    }

    if (!startUrl) {
        log.warning('No startUrl or searchQuery in input, using default for testing.');
        startUrl = 'https://www.faire.com/search?q=candles';
    }

    const RESULTS_WANTED = Number.isFinite(+resultsWanted) ? Math.max(1, +resultsWanted) : 20;
    let totalCollected = 0;

    const proxyConfiguration = await Actor.createProxyConfiguration(
        proxyConfig || {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        },
    );

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 5,
        maxConcurrency: 1,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxUsageCount: 15,
                maxErrorScore: 5,
            },
        },
        requestHandlerTimeoutSecs: 900,
        navigationTimeoutSecs: 120,

        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [
                        { name: 'chrome', minVersion: 120, maxVersion: 130 }
                    ],
                    operatingSystems: ['windows', 'macos'],
                    devices: ['desktop'],
                    locales: ['en-US', 'en'],
                },
            },
        },

        preNavigationHooks: [async ({ page, context }) => {
            // Block heavy resources
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'font', 'media'].includes(type) || route.request().url().includes('google-analytics')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Inject Cookies if provided
            if (cookies && cookies.length > 0) {
                await page.context().addCookies(cookies);
            }

            await page.addInitScript(STEALTH_SCRIPT);
            await page.setViewportSize({ width: 1440, height: 900 });
        }],

        async requestHandler({ page, request, proxyInfo }) {
            if (totalCollected >= RESULTS_WANTED) return;
            log.info(`Processing listing: ${request.url}`);

            const allProducts = [];

            // Setup route-based API interception with proper response storage
            await page.route('**/api/v3/**', async (route) => {
                const response = await route.fetch();
                const url = route.request().url();

                if (url.includes('/search/products') || url.includes('/search-product-tiles')) {
                    try {
                        const body = await response.text();
                        const json = JSON.parse(body);
                        const products = json.products || json.product_tiles || json.results;

                        if (products && Array.isArray(products)) {
                            log.info(`✅ Captured API response with ${products.length} products`);
                            for (const p of products) {
                                const token = p.token || p.id;
                                if (!token) continue;

                                allProducts.push({
                                    productUrl: `https://www.faire.com/product/${token}`,
                                    productName: p.name || p.title || '',
                                    brandName: p.brand?.name || '',
                                    brandUrl: p.brand?.token ? `https://www.faire.com/brand/${p.brand?.token}` : '',
                                    imageUrl: p.images?.[0]?.url || p.image?.url || null,
                                    wholesalePrice: p.price?.wholesale_price_cents ? `$${(p.price.wholesale_price_cents / 100).toFixed(2)}` : '',
                                    msrp: p.price?.retail_price_cents ? `$${(p.price.retail_price_cents / 100).toFixed(2)}` : '',
                                    isBestseller: p.badges?.includes('bestseller') || false,
                                    isNew: p.badges?.includes('new') || false
                                });
                            }
                        }

                        await route.fulfill({ response });
                    } catch (e) {
                        await route.fulfill({ response });
                    }
                } else {
                    await route.fulfill({ response });
                }
            });

            // Wait for page and initial API call
            await page.waitForTimeout(3000);
            log.info(`After initial wait: ${allProducts.length} products captured`);

            // Scroll to load more
            for (let i = 0; i < 3 && allProducts.length < RESULTS_WANTED; i++) {
                await autoScroll(page);
                await page.waitForTimeout(2000);
                log.info(`After scroll ${i + 1}: ${allProducts.length} products total`);
            }

            // Process captured products
            if (allProducts.length === 0) {
                log.warning('No products captured from API. Exiting.');
                return;
            }

            // Deduplicate
            const uniqueProducts = [];
            const seen = new Set();
            for (const product of allProducts) {
                if (!seen.has(product.productUrl)) {
                    seen.add(product.productUrl);
                    uniqueProducts.push(product);
                }
            }

            log.info(`Processing ${uniqueProducts.length} unique products (${RESULTS_WANTED} requested)`);
            const toProcess = uniqueProducts.slice(0, RESULTS_WANTED);

            // Fetch details and save
            const results = await fetchDetailsInBatches(toProcess, cookies, proxyInfo?.url);
            if (results.length > 0) {
                await Dataset.pushData(results);
                totalCollected += results.length;
            }

            log.info(`✅ Scraping finished. Total products collected: ${totalCollected}`);
        }
    });

    await crawler.run([startUrl]);
}

// Extract data from __NEXT_DATA__ (Next.js sites)
async function extractNextData(page) {
    try {
        const nextDataText = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : null;
        });

        if (!nextDataText) return null;

        const json = JSON.parse(nextDataText);

        // Navigate through common Next.js structures
        const products = json?.props?.pageProps?.products ||
            json?.props?.pageProps?.data?.products ||
            json?.props?.pageProps?.initialState?.products ||
            json?.props?.pageProps?.results ||
            null;

        if (products && Array.isArray(products)) {
            return products.map(p => ({
                productUrl: p.url || p.productUrl || (p.token ? `https://www.faire.com/product/${p.token}` : null),
                productName: p.name || p.title || p.productName || 'Unknown Product',
                brandName: p.brand?.name || p.brandName || '',
                brandUrl: p.brand?.url || (p.brandToken ? `https://www.faire.com/brand/${p.brandToken}` : ''),
                wholesalePrice: p.wholesalePrice || p.price?.wholesale || '',
                msrp: p.msrp || p.retailPrice || p.price?.retail || '',
                imageUrl: p.imageUrl || p.image || p.thumbnail || null,
                isBestseller: p.isBestseller || p.badges?.includes('bestseller') || false,
                isProvenSuccess: p.isProvenSuccess || p.badges?.includes('proven') || false,
                isNew: p.isNew || p.badges?.includes('new') || false
            })).filter(p => p.productUrl);
        }

        return null;
    } catch (e) {
        return null;
    }
}

// Batch fetch product details with retry logic
async function fetchDetailsInBatches(items, cookies, proxyUrl) {
    const results = [];
    for (let i = 0; i < items.length; i += DETAIL_PAGE_CONCURRENCY) {
        const chunk = items.slice(i, i + DETAIL_PAGE_CONCURRENCY);
        const promises = chunk.map(item => fetchProductDetails(item, cookies, proxyUrl));
        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));

        // Human-like delay between batches
        if (i + DETAIL_PAGE_CONCURRENCY < items.length) {
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }
    }
    return results;
}

async function fetchProductDetails(listingItem, cookies, proxyUrl) {
    const { productUrl, productName: listingName, imageUrl: listingImage, isBestseller, isProvenSuccess, isNew } = listingItem;

    try {
        const cookieHeader = cookies && cookies.length > 0
            ? cookies.map(c => `${c.name}=${c.value}`).join('; ')
            : '';

        const response = await gotScraping({
            url: productUrl,
            proxyUrl,
            headers: {
                'Cookie': cookieHeader,
                'Referer': 'https://www.faire.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows'],
            },
            timeout: { request: 30000 }
        });

        const $ = load(response.body);

        // Check for blocking
        const title = $('title').text();
        if (title.includes('Access Denied') || title.includes('Captcha')) {
            log.warning(`Blocked on detail page: ${productUrl}`);
            return listingItem; // Return basic info at least
        }

        // Try JSON-LD first
        let jsonLdData = null;
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).text());
                if (json['@type'] === 'Product') {
                    jsonLdData = json;
                    return false;
                }
            } catch { }
        });

        if (jsonLdData) {
            return {
                productName: jsonLdData.name || listingName,
                brandName: jsonLdData.brand?.name || '',
                brandUrl: jsonLdData.brand?.url || '',
                productUrl,
                imageUrl: jsonLdData.image || listingImage,
                wholesalePrice: jsonLdData.offers?.price || listingItem.wholesalePrice || '',
                msrp: jsonLdData.offers?.priceSpecification?.price || listingItem.msrp || '',
                discount: '',
                isBestseller: isBestseller || false,
                isProvenSuccess: isProvenSuccess || false,
                isNew: isNew || false,
                currency: jsonLdData.offers?.priceCurrency || 'USD',
                _scrapedAt: new Date().toISOString()
            };
        }

        // Fallback checks for price if missing
        let wholesalePrice = listingItem.wholesalePrice;
        let msrp = listingItem.msrp;

        if (!wholesalePrice && cookies.length > 0) {
            const wText = $(':contains("Wholesale")').filter((i, el) => /\$\d+/.test($(el).text())).last().text();
            if (wText) {
                const m = wText.match(/\$[\d,.]+/);
                if (m) wholesalePrice = m[0];
            }
        }

        return {
            ...listingItem,
            wholesalePrice: wholesalePrice || (cookies.length === 0 ? 'Login required' : ''),
            msrp: msrp || '',
            _scrapedAt: new Date().toISOString()
        };

    } catch (e) {
        log.error(`Failed to fetch details for ${productUrl}: ${e.message}`);
        return listingItem;
    }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 20000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150);
        });
    });
}

main().catch((error) => {
    log.error('Actor failed', { error: error.message });
    process.exit(1);
});
