import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load } from 'cheerio';

const DETAIL_PAGE_CONCURRENCY = 5; // Reduced for better reliability
const MAX_SCROLL_HEIGHT = 20000; // Increased for more results

// Enhanced stealth script
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
        maxRequestRetries: 5, // Increased retries
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
                await context.addCookies(cookies);
            }

            await page.addInitScript(STEALTH_SCRIPT);
            await page.setViewportSize({ width: 1440, height: 900 });
        }],

        async requestHandler({ page, request, proxyInfo }) {
            if (totalCollected >= RESULTS_WANTED) return;
            log.info(`Processing listing: ${request.url}`);

            // Add human-like delay before interaction
            await page.waitForTimeout(2000 + Math.random() * 2000);

            // Check for blocking
            const pageTitle = await page.title().catch(() => '');
            log.info(`Page title: ${pageTitle}`);

            if (pageTitle.includes('Access Denied') || pageTitle.includes('Captcha') || pageTitle.includes('Challenge')) {
                log.error('⚠️ BLOCKED! Site detected bot behavior. Saving debug page...');
                const html = await page.content();
                await Actor.setValue('debug-blocked', html, { contentType: 'text/html' });
                throw new Error('Blocked by anti-bot protection');
            }

            // PRIORITY 1: Check for __NEXT_DATA__
            const nextDataProducts = await extractNextData(page);
            if (nextDataProducts && nextDataProducts.length > 0) {
                log.info(`✅ Found ${nextDataProducts.length} products via __NEXT_DATA__`);
                const itemsNeeded = Math.min(nextDataProducts.length, RESULTS_WANTED - totalCollected);
                const itemsToProcess = nextDataProducts.slice(0, itemsNeeded);
                
                const detailResults = await fetchDetailsInBatches(itemsToProcess, cookies, proxyInfo?.url);
                if (detailResults.length > 0) {
                    await Dataset.pushData(detailResults);
                    totalCollected += detailResults.length;
                    log.info(`Collected ${detailResults.length} products from __NEXT_DATA__. Total: ${totalCollected}`);
                }
                return;
            }

            let currentPageNum = 1;

            // PRIORITY 2: Fallback to DOM scraping with pagination
            while (totalCollected < RESULTS_WANTED) {
                try {
                    // Wait for grid to load with multiple selectors
                    const gridLoaded = await page.waitForSelector(
                        'a[href*="product="], [data-testid*="product"], article a',
                        { timeout: 30000 }
                    ).catch(() => {
                        log.warning('⚠️ Product grid timeout, attempting to save debug HTML...');
                        return null;
                    });

                    if (!gridLoaded) {
                        const html = await page.content();
                        await Actor.setValue('debug-no-products', html, { contentType: 'text/html' });
                        log.error('No products found. Debug HTML saved.');
                        break;
                    }

                    // Auto-scroll to trigger lazy loads
                    await autoScroll(page);
                    await page.waitForTimeout(2000); // Let content settle

                    // Extract Product Links from Grid
                    const remainingWanted = RESULTS_WANTED - totalCollected;

                    // Evaluate page to get all visible product cards with multiple fallback selectors
                    const productItems = await page.evaluate(() => {
                        const items = [];
                        
                        // Try multiple selector strategies
                        const selectors = [
                            'a[href*="product="]',
                            'a[href*="/product/"]',
                            '[data-testid*="product"] a',
                            'article a',
                            '[class*="ProductCard"] a',
                            '[class*="product-card"] a'
                        ];

                        let productLinks = [];
                        for (const selector of selectors) {
                            productLinks = document.querySelectorAll(selector);
                            if (productLinks.length > 0) {
                                console.log(`Found ${productLinks.length} products with selector: ${selector}`);
                                break;
                            }
                        }

                        productLinks.forEach(a => {
                            const url = a.href;
                            if (!url || !url.includes('faire.com')) return;

                            // Find title and image with multiple strategies
                            const titleEl = a.querySelector('p, h2, h3, [class*="title"], [class*="Title"]') || 
                                          a.parentElement?.querySelector('p, h2, h3');
                            const imgEl = a.querySelector('img') || a.parentElement?.querySelector('img');

                            // Extract badges/flags
                            const container = a.closest('article, [class*="Card"], div');
                            const badgeText = container?.innerText || '';
                            
                            items.push({
                                productUrl: url,
                                productName: titleEl?.innerText?.trim() || '',
                                imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || null,
                                isBestseller: badgeText.toLowerCase().includes('bestseller') || badgeText.includes('🔥'),
                                isProvenSuccess: badgeText.toLowerCase().includes('proven success'),
                                isNew: badgeText.toLowerCase().includes('new') && !badgeText.toLowerCase().includes('news')
                            });
                        });
                        
                        return items;
                    });

                    // De-duplicate and filter
                    const uniqueItems = productItems
                        .filter((v, i, a) => a.findIndex(t => t.productUrl === v.productUrl) === i)
                        .filter(item => item.productUrl && item.productName);

                    // Slice to needed
                    const itemsToProcess = uniqueItems.slice(0, remainingWanted);

                    log.info(`Found ${uniqueItems.length} unique products on page ${currentPageNum}. Processing ${itemsToProcess.length}...`);

                    if (itemsToProcess.length === 0) {
                        log.warning('No valid products found on this page. Stopping.');
                        break;
                    }

                    // Fetch Details using got-scraping in batches
                    const detailResults = await fetchDetailsInBatches(itemsToProcess, cookies, proxyInfo?.url);

                    if (detailResults.length > 0) {
                        await Dataset.pushData(detailResults);
                        totalCollected += detailResults.length;
                    }

                    if (totalCollected >= RESULTS_WANTED) break;

                    // Pagination Navigation with multiple strategies
                    const paginationResult = await navigateToNextPage(page);
                    if (!paginationResult) {
                        log.info('No more pages available. End of results.');
                        break;
                    }
                    
                    currentPageNum++;
                    await page.waitForTimeout(2000 + Math.random() * 2000); // Human-like delay

                } catch (e) {
                    log.error(`Error on page ${currentPageNum}: ${e.message}`);
                    break;
                }
            }
        },
    });

    await crawler.run([startUrl]);
    log.info(`✅ Scraping finished. Total products collected: ${totalCollected}`);
    await Actor.exit();
}

// PRIORITY 1: Extract data from __NEXT_DATA__ (Next.js sites)
async function extractNextData(page) {
    try {
        const nextDataText = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : null;
        });

        if (!nextDataText) {
            log.debug('No __NEXT_DATA__ found');
            return null;
        }

        const json = JSON.parse(nextDataText);
        log.debug('__NEXT_DATA__ structure:', Object.keys(json));

        // Navigate through common Next.js structures
        const products = json?.props?.pageProps?.products || 
                        json?.props?.pageProps?.data?.products ||
                        json?.props?.pageProps?.initialState?.products ||
                        json?.props?.pageProps?.results ||
                        null;

        if (products && Array.isArray(products)) {
            return products.map(p => ({
                productUrl: p.url || p.productUrl || `https://www.faire.com/product/${p.id || p.token}`,
                productName: p.name || p.title || p.productName || '',
                brandName: p.brand?.name || p.brandName || '',
                brandUrl: p.brand?.url || (p.brandToken ? `https://www.faire.com/brand/${p.brandToken}` : ''),
                wholesalePrice: p.wholesalePrice || p.price?.wholesale || '',
                msrp: p.msrp || p.retailPrice || p.price?.retail || '',
                imageUrl: p.imageUrl || p.image || p.thumbnail || '',
                isBestseller: p.isBestseller || p.badges?.includes('bestseller') || false,
                isProvenSuccess: p.isProvenSuccess || p.badges?.includes('proven') || false,
                isNew: p.isNew || p.badges?.includes('new') || false
            }));
        }

        return null;
    } catch (e) {
        log.debug(`__NEXT_DATA__ extraction failed: ${e.message}`);
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
        log.info(`Processed ${Math.min(items.length, i + DETAIL_PAGE_CONCURRENCY)} / ${items.length} details...`);
        
        // Human-like delay between batches
        if (i + DETAIL_PAGE_CONCURRENCY < items.length) {
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }
    }
    return results;
}

// Navigate to next page with multiple strategies
async function navigateToNextPage(page) {
    try {
        // Strategy 1: Look for Next button with aria-label
        const nextButton = await page.$('a[aria-label="Next page"], button[aria-label="Next page"], a[aria-label="Next"], button[aria-label="Next"]');
        
        if (nextButton) {
            const isDisabled = await nextButton.getAttribute('disabled') !== null;
            const ariaDisabled = await nextButton.getAttribute('aria-disabled');
            
            if (isDisabled || ariaDisabled === 'true') {
                log.info('Next button is disabled. End of results.');
                return false;
            }
            
            log.info('Clicking Next Page button...');
            await Promise.all([
                page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
                nextButton.click()
            ]);
            return true;
        }

        // Strategy 2: Look for numbered pagination
        const currentPage = await page.$('[aria-current="page"]');
        if (currentPage) {
            const nextPageLink = await page.$('a[aria-label*="Page"]:not([aria-current])');
            if (nextPageLink) {
                log.info('Clicking numbered pagination...');
                await nextPageLink.click();
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                return true;
            }
        }

        // Strategy 3: URL parameter increment
        const currentUrl = page.url();
        const urlObj = new URL(currentUrl);
        const pageParam = urlObj.searchParams.get('page');
        
        if (pageParam) {
            const nextPage = parseInt(pageParam) + 1;
            urlObj.searchParams.set('page', nextPage.toString());
            log.info(`Navigating to page ${nextPage} via URL parameter...`);
            await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded' });
            return true;
        }

        return false;
    } catch (e) {
        log.error(`Pagination navigation failed: ${e.message}`);
        return false;
    }
}

async function fetchProductDetails(listingItem, cookies, proxyUrl) {
    const { productUrl, productName: listingName, imageUrl: listingImage, isBestseller, isProvenSuccess, isNew } = listingItem;
    
    try {
        // Construct Cookie Header
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
                'Accept-Language': 'en-US,en;q=0.9',
            },
            headerGeneratorOptions: {
                browsers: [
                    { name: 'chrome', minVersion: 120, maxVersion: 130 },
                    { name: 'firefox', minVersion: 115, maxVersion: 125 }
                ],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows', 'macos'],
            },
            retry: {
                limit: 3,
                methods: ['GET'],
                statusCodes: [408, 429, 500, 502, 503, 504],
            },
            timeout: {
                request: 30000,
            }
        });

        const $ = load(response.body);

        // Check for blocking
        const title = $('title').text();
        if (title.includes('Access Denied') || title.includes('Captcha')) {
            log.warning(`Blocked on detail page: ${productUrl}`);
            return null;
        }

        // PRIORITY 1: Try __NEXT_DATA__
        const nextData = $('script#__NEXT_DATA__').text();
        if (nextData) {
            try {
                const json = JSON.parse(nextData);
                const productData = json?.props?.pageProps?.product || 
                                   json?.props?.pageProps?.data?.product ||
                                   json?.props?.pageProps?.initialProduct;

                if (productData) {
                    log.debug('Extracted product from __NEXT_DATA__');
                    return formatProductData(productData, productUrl, cookies.length > 0);
                }
            } catch (e) {
                log.debug('__NEXT_DATA__ parse failed on detail page');
            }
        }

        // PRIORITY 2: Try JSON-LD
        let jsonLdData = null;
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).text());
                if (json['@type'] === 'Product') {
                    jsonLdData = json;
                    return false; // break
                }
            } catch {}
        });

        if (jsonLdData) {
            log.debug('Extracted product from JSON-LD');
            return {
                productName: jsonLdData.name || listingName,
                brandName: jsonLdData.brand?.name || '',
                brandUrl: jsonLdData.brand?.url || '',
                productUrl,
                imageUrl: jsonLdData.image || listingImage,
                wholesalePrice: jsonLdData.offers?.price || '',
                msrp: jsonLdData.offers?.priceSpecification?.price || '',
                discount: calculateDiscount(jsonLdData.offers?.price, jsonLdData.offers?.priceSpecification?.price),
                isBestseller: isBestseller || false,
                isProvenSuccess: isProvenSuccess || false,
                isNew: isNew || false,
                currency: jsonLdData.offers?.priceCurrency || 'USD',
                _scrapedAt: new Date().toISOString()
            };
        }

        // PRIORITY 3: Fallback to HTML parsing with multiple selectors
        const productName = $('h1, [data-testid="product-title"], [class*="ProductTitle"]')
            .first().text().trim() || listingName;

        const brandName = $('a[href^="/brand/"] span, [data-testid="brand-name"], [class*="BrandName"]')
            .first().text().trim();

        const brandUrl = $('a[href^="/brand/"]').attr('href') 
            ? `https://www.faire.com${$('a[href^="/brand/"]').attr('href')}`
            : '';

        const imageUrl = $('img[src*="faire"], [data-testid="product-image"] img')
            .filter((i, el) => $(el).attr('src')?.includes('http'))
            .first().attr('src') || listingImage;

        // Price extraction with multiple strategies
        let wholesalePrice = '';
        let msrp = '';

        // Look for price containers
        const priceSelectors = [
            '[data-testid*="price"]',
            '[class*="Price"]',
            '[class*="price"]',
            'span:contains("$")',
            'div:contains("$")'
        ];

        let priceElements = [];
        for (const selector of priceSelectors) {
            priceElements = $(selector).filter((i, el) => /\$[\d,.]+/.test($(el).text()));
            if (priceElements.length > 0) break;
        }

        // Extract prices from text content
        const allPrices = [];
        priceElements.each((i, el) => {
            const text = $(el).text();
            const matches = text.match(/\$[\d,.]+/g);
            if (matches) allPrices.push(...matches);
        });

        // Try to identify wholesale vs retail
        const bodyText = $('body').text().toLowerCase();
        
        if (cookies.length > 0) {
            // Authenticated - look for wholesale price
            const wholesaleText = $(':contains("Wholesale"), :contains("wholesale")')
                .filter((i, el) => /\$\d+/.test($(el).text()))
                .first().text();
            
            const wholesaleMatch = wholesaleText.match(/\$[\d,.]+/);
            if (wholesaleMatch) wholesalePrice = wholesaleMatch[0];
        }

        // Look for MSRP/Retail
        const msrpText = $(':contains("MSRP"), :contains("Retail"), :contains("retail")')
            .filter((i, el) => /\$\d+/.test($(el).text()))
            .first().text();
        
        const msrpMatch = msrpText.match(/\$[\d,.]+/);
        if (msrpMatch) msrp = msrpMatch[0];

        // If no specific labels, use first two unique prices
        const uniquePrices = [...new Set(allPrices)];
        if (!wholesalePrice && uniquePrices.length > 0) {
            wholesalePrice = uniquePrices[0] || '';
        }
        if (!msrp && uniquePrices.length > 1) {
            msrp = uniquePrices[1] || '';
        }

        // Calculate discount
        const discount = calculateDiscount(wholesalePrice, msrp);

        return {
            productName,
            brandName,
            brandUrl,
            productUrl,
            imageUrl,
            wholesalePrice: wholesalePrice || (cookies.length === 0 ? 'Login required' : ''),
            msrp: msrp || '',
            discount,
            isBestseller: isBestseller || false,
            isProvenSuccess: isProvenSuccess || false,
            isNew: isNew || false,
            currency: 'USD',
            _scrapedAt: new Date().toISOString()
        };

    } catch (e) {
        log.error(`Failed to fetch details for ${productUrl}: ${e.message}`);
        
        // Return partial data on error
        return {
            productName: listingName || 'Error fetching details',
            brandName: '',
            brandUrl: '',
            productUrl,
            imageUrl: listingItem.imageUrl || '',
            wholesalePrice: 'Error',
            msrp: 'Error',
            discount: '',
            isBestseller: isBestseller || false,
            isProvenSuccess: isProvenSuccess || false,
            isNew: isNew || false,
            currency: 'USD',
            _scrapedAt: new Date().toISOString()
        };
    }
}

// Format product data from __NEXT_DATA__
function formatProductData(data, url, isAuthenticated) {
    return {
        productName: data.name || data.title || '',
        brandName: data.brand?.name || data.brandName || '',
        brandUrl: data.brand?.url || (data.brandToken ? `https://www.faire.com/brand/${data.brandToken}` : ''),
        productUrl: url,
        imageUrl: data.imageUrl || data.image || data.thumbnail || '',
        wholesalePrice: data.wholesalePrice || data.price?.wholesale || (isAuthenticated ? '' : 'Login required'),
        msrp: data.msrp || data.retailPrice || data.price?.retail || '',
        discount: calculateDiscount(data.wholesalePrice || data.price?.wholesale, data.msrp || data.retailPrice),
        isBestseller: data.isBestseller || data.badges?.includes('bestseller') || false,
        isProvenSuccess: data.isProvenSuccess || data.badges?.includes('proven') || false,
        isNew: data.isNew || data.badges?.includes('new') || false,
        currency: data.currency || 'USD',
        _scrapedAt: new Date().toISOString()
    };
}

// Calculate discount percentage
function calculateDiscount(wholesalePrice, msrp) {
    if (!wholesalePrice || !msrp) return '';
    
    try {
        const wholesale = parseFloat(wholesalePrice.replace(/[^0-9.]/g, ''));
        const retail = parseFloat(msrp.replace(/[^0-9.]/g, ''));
        
        if (wholesale && retail && retail > wholesale) {
            const discount = ((retail - wholesale) / retail * 100).toFixed(0);
            return `${discount}%`;
        }
    } catch (e) {
        log.debug('Discount calculation failed');
    }
    
    return '';
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400; // Increased scroll distance
            const maxHeight = 20000; // Increased max height
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                
                // Stop if reached bottom or max height
                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight >= maxHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150); // Slightly slower scroll for more natural behavior
        });
    });
}

main().catch((error) => {
    log.error('Actor failed', { error: error.message });
    process.exit(1);
});
