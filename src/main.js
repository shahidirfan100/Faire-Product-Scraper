import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load } from 'cheerio';

const DETAIL_PAGE_CONCURRENCY = 10;

const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
};

async function main() {
    await Actor.init();

    const input = (await Actor.getInput()) || {};
    console.log('Received Input:', JSON.stringify(input, null, 2));

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

    // Fallback for local testing if input is not picked up
    if (!startUrl) {
        log.warning('No startUrl or searchQuery in input, using default for testing.');
        startUrl = 'https://www.faire.com/search?q=candles';
    }

    if (!startUrl) {
        throw new Error('Please provide a startUrl or searchQuery.');
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
        maxRequestRetries: 3,
        maxConcurrency: 1, // Single page flow for reliable infinite scroll/pagination
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 5,
            sessionOptions: { maxUsageCount: 10 },
        },
        requestHandlerTimeoutSecs: 900,
        navigationTimeoutSecs: 120,

        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    operatingSystems: ['windows', 'macos'],
                    devices: ['desktop'],
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
                await context.addCookies(cookies);
            }

            await page.addInitScript(STEALTH_SCRIPT);
            await page.setViewportSize({ width: 1440, height: 900 });
        }],

        async requestHandler({ page, request, proxyInfo }) {
            if (totalCollected >= RESULTS_WANTED) return;
            log.info(`Processing listing: ${request.url}`);

            let currentPageNum = 1;
            const baseUrl = new URL(request.url);

            // Handle Pagination Loop
            while (totalCollected < RESULTS_WANTED) {
                try {
                    // Wait for grid to load
                    await page.waitForSelector('a[href*="product="]', { timeout: 30000 }).catch(() => log.warning('Product grid timeout, retrying or empty.'));

                    // Auto-scroll to trigger lazy loads
                    await autoScroll(page);

                    // Extract Product Links from Grid
                    const remainingWanted = RESULTS_WANTED - totalCollected;

                    // Evaluate page to get all visible product cards
                    const productItems = await page.evaluate(() => {
                        const items = [];
                        // Select all anchors that look like products
                        const productLinks = document.querySelectorAll('a[href*="product="]');

                        productLinks.forEach(a => {
                            const url = a.href;
                            // Find container
                            let container = a.parentElement;
                            // Traverse up to find a container that holds image and title (simple heuristic)
                            // Usually simple structure: div > a > img + p

                            const titleEl = a.querySelector('p') || a.parentElement.querySelector('p');
                            const imgEl = a.querySelector('img');

                            if (url && titleEl) {
                                items.push({
                                    productUrl: url,
                                    listingTitle: titleEl.innerText.trim(),
                                    listingImage: imgEl ? imgEl.src : null
                                });
                            }
                        });
                        return items;
                    });

                    // De-duplicate items found on this page vs previous batches if needed (but we navigate pages, so mainly local dedupe)
                    const uniqueItems = productItems.filter((v, i, a) => a.findIndex(t => t.productUrl === v.productUrl) === i);

                    // Slice to needed
                    const itemsToProcess = uniqueItems.slice(0, remainingWanted);

                    log.info(`Found ${uniqueItems.length} products on page ${currentPageNum}. Processing ${itemsToProcess.length}...`);

                    if (itemsToProcess.length === 0) {
                        log.info('No products found on this page. Stopping.');
                        break;
                    }

                    // Hybrid: Fetch Details using got-scraping
                    const detailResults = [];
                    for (let i = 0; i < itemsToProcess.length; i += DETAIL_PAGE_CONCURRENCY) {
                        const chunk = itemsToProcess.slice(i, i + DETAIL_PAGE_CONCURRENCY);
                        const promises = chunk.map(item => fetchProductDetails(item, cookies, proxyInfo?.url));
                        const chunkResults = await Promise.all(promises);
                        detailResults.push(...chunkResults.filter(r => r !== null));
                        log.info(`Processed ${Math.min(itemsToProcess.length, i + DETAIL_PAGE_CONCURRENCY)} / ${itemsToProcess.length} details...`);
                    }

                    if (detailResults.length > 0) {
                        await Dataset.pushData(detailResults);
                        totalCollected += detailResults.length;
                    }

                    if (totalCollected >= RESULTS_WANTED) break;

                    // Pagination Navigation
                    const nextButton = await page.$('a[aria-label="Next page"], button[aria-label="Next page"]');
                    if (nextButton) {
                        const isDisabled = await nextButton.getAttribute('disabled') !== null;
                        if (isDisabled) {
                            log.info('Next button disabled. End of results.');
                            break;
                        }
                        log.info('Clicking Next Page...');
                        await Promise.all([
                            page.waitForURL(/page=\d+/, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(e => log.debug('URL wait timeout (might be ajax)')),
                            nextButton.click(),
                        ]);
                        currentPageNum++;
                        await page.waitForTimeout(3000); // Settle
                    } else {
                        log.info('No Next button found. End of results.');
                        break;
                    }

                } catch (e) {
                    log.error(`Error on page ${currentPageNum}: ${e.message}`);
                    break;
                }
            }
        },
    });

    await crawler.run([startUrl]);
    log.info(`Scraping finished. Total products collected: ${totalCollected}`);
    await Actor.exit();
}

async function fetchProductDetails(listingItem, cookies, proxyUrl) {
    const { productUrl } = listingItem;
    try {
        // Construct Cookie Header
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        const response = await gotScraping({
            url: productUrl,
            proxyUrl,
            headers: {
                'Cookie': cookieHeader,
                // Add Referer to look legit
                'Referer': 'https://www.faire.com/',
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows'],
            }
        });

        const $ = load(response.body);

        // Selectors
        const title = $('h1').text().trim() || listingItem.listingTitle;
        const brand = $('a[href^="/brand/"] span').first().text().trim() || $('[class*="BrandName"]').text().trim();
        const brandUrl = $('a[href^="/brand/"]').attr('href') ? `https://www.faire.com${$('a[href^="/brand/"]').attr('href')}` : null;
        const description = $('[class*="Description"], [class*="description"]').first().text().trim();
        const imageUrl = $('img').filter((i, el) => $(el).attr('src')?.includes('http')).first().attr('src') || listingItem.listingImage;

        // Price Parsing
        // Look for any text containing '$' or currency symbols
        // If logged in, we expect strict prices. If not, we might see "Unlock"
        const allText = $('body').text();
        let price = null;
        let wholesalePrice = null;
        let retailPrice = null; // MSRP

        // Simpler heuristic: look for price-like patterns near "MSRP" or in standard price classes
        const msrpText = $('*[class*="RetailPrice"], :contains("MSRP"), :contains("Retail")').filter((i, el) => /\$\d+/.test($(el).text())).last().text();
        if (msrpText) {
            const m = msrpText.match(/\$[\d,.]+/);
            if (m) retailPrice = m[0];
        }

        // Wholesale often requires login
        // If we provided cookies, look for the main price.
        // Usually the main bold price on the page or near "Wholesale"
        if (cookies.length > 0) {
            const wText = $(':contains("Wholesale")').filter((i, el) => /\$\d+/.test($(el).text())).last().text();
            if (wText) {
                const m = wText.match(/\$[\d,.]+/);
                if (m) wholesalePrice = m[0];
            }
        } else {
            // Guest mode
            price = "Unlock wholesale price";
        }

        return {
            title,
            brand,
            brandUrl,
            productUrl,
            imageUrl,
            description: description.substring(0, 500) + '...', // Truncate
            wholesalePrice,
            retailPrice,
            currency: 'USD', // Default assumption for Faire US, logic can be improved
            status: (wholesalePrice || cookies.length > 0) ? "Authenticated/Scraped" : "Public/Guest",
            _scrapedAt: new Date().toISOString()
        };

    } catch (e) {
        log.error(`Failed to fetch details for ${productUrl}: ${e.message}`);
        return null;
    }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 15000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

main().catch((error) => {
    log.error('Actor failed', { error: error.message });
    process.exit(1);
});
