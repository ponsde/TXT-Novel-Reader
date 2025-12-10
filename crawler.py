import sys
import json
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin
import re
import time

# 设置标准输出编码为UTF-8，防止中文乱码
sys.stdout.reconfigure(encoding='utf-8')

def get_headers():
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    }

def fetch_url(url):
    try:
        response = requests.get(url, headers=get_headers(), timeout=15)
        # 自动检测编码
        if response.encoding == 'ISO-8859-1':
            response.encoding = response.apparent_encoding
        # 如果自动检测失败，尝试常见的中文编码
        if response.text and '' in response.text:
             # 简单的启发式尝试
             try:
                 content = response.content.decode('gbk')
                 return content
             except:
                 pass
        return response.text
    except Exception as e:
        # print(f"Error fetching {url}: {e}", file=sys.stderr)
        return None

def is_chapter_link(text, href):
    # 排除明显的非章节链接
    exclude_keywords = ['首页', '登录', '注册', '上一页', '下一页', '返回', '加入书架', '投票', '留言', '下载', '更多', '直达', '底部']
    if any(k in text for k in exclude_keywords):
        return False
    
    # 必须包含章节相关的字，或者看起来像章节名
    # 宽松匹配：数字+章/节/回，或者纯数字开头
    if re.search(r'第[0-9一二三四五六七八九十百千]+[章回节]', text):
        return True
    if re.search(r'^\d+[\.\s、]', text):
        return True
    if re.match(r'^\d+$', text): # 纯数字链接通常也是
        return True
        
    # 如果是在明确的目录容器里，稍微放宽
    return len(text) > 2

def parse_chapters(start_url):
    all_chapters = []
    visited_urls = set()
    urls_to_visit = [start_url]
    
    # 限制翻页次数，防止死循环
    max_pages = 50 
    page_count = 0

    # 智能跳转：检查是否需要先跳转到"完整目录"
    # 有些网站首页只有最新章节，需要点"查看更多"
    first_html = fetch_url(start_url)
    if not first_html:
        return []
        
    first_soup = BeautifulSoup(first_html, 'html.parser')
    
    # 检查是否有"查看更多"或"完整目录"链接
    more_link = None
    for a in first_soup.find_all('a'):
        text = a.get_text().strip()
        if '查看更多' in text or '全部章节' in text or '完整目录' in text:
            href = a.get('href')
            if href and not href.startswith('javascript') and href != '#':
                more_link = urljoin(start_url, href)
                break
    
    if more_link and more_link != start_url:
        # print(f"Found full catalog link: {more_link}", file=sys.stderr)
        urls_to_visit = [more_link]
        visited_urls.add(start_url) # 标记原URL已访问

    while urls_to_visit and page_count < max_pages:
        current_url = urls_to_visit.pop(0)
        if current_url in visited_urls:
            continue
        visited_urls.add(current_url)
        page_count += 1
        
        # print(f"Crawling: {current_url}", file=sys.stderr)
        html = fetch_url(current_url)
        if not html:
            continue
            
        soup = BeautifulSoup(html, 'html.parser')
        
        # 1. 提取章节
        # 策略：找到包含最多链接的容器
        containers = []
        # 常见的目录容器ID/Class
        selectors = ['#list', '.list', '.catalog', '.chapter-list', '.book_list', '.directory', '.box_con', '#chapterlist']
        
        best_container = None
        max_link_count = 0
        
        # 先尝试特定选择器
        for selector in selectors:
            for container in soup.select(selector):
                links = container.find_all('a')
                if len(links) > max_link_count:
                    max_link_count = len(links)
                    best_container = container
        
        # 如果没找到，尝试所有 div
        if not best_container:
            for div in soup.find_all('div'):
                links = div.find_all('a')
                # 过滤掉导航栏等链接少的div，但也不能太少
                if len(links) > 20: 
                    if len(links) > max_link_count:
                        max_link_count = len(links)
                        best_container = div
                        
        target_links = best_container.find_all('a') if best_container else soup.find_all('a')
        
        page_chapters = []
        for a in target_links:
            text = a.get_text().strip()
            href = a.get('href')
            if text and href:
                if is_chapter_link(text, href):
                    full_url = urljoin(current_url, href)
                    # 去重
                    if not any(c['url'] == full_url for c in all_chapters) and not any(c['url'] == full_url for c in page_chapters):
                        page_chapters.append({
                            'title': text,
                            'url': full_url
                        })
        
        all_chapters.extend(page_chapters)
        
        # 2. 处理分页 (下一页)
        # 查找包含"下一页"文字的链接
        next_page_url = None
        for a in soup.find_all('a'):
            if '下一页' in a.get_text():
                href = a.get('href')
                if href:
                    next_page_url = urljoin(current_url, href)
                    break
        
        if next_page_url and next_page_url not in visited_urls:
            urls_to_visit.append(next_page_url)
            
        # 稍微延时，礼貌爬取
        time.sleep(0.5)

    return all_chapters

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
        
    target_url = sys.argv[1]
    try:
        chapters = parse_chapters(target_url)
        print(json.dumps(chapters, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
