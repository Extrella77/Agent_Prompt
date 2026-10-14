# 导包
import os
import json


import requests
from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_chroma import Chroma
from langchain.tools import tool
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.messages import messages_to_dict, messages_from_dict
from langchain_openai import OpenAIEmbeddings
from langchain_openai import ChatOpenAI
from langchain_community.document_loaders import TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from datetime import datetime

# 加载环境
load_dotenv()

###############配置###############
AI_DATA = "data/15个高频AI基础概念大白话通俗讲解.md"
# 配置大模型
def call_qwen():
    llm = ChatOpenAI(
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
        model="qwen3.8-flash",
        temperature=0.9,
        max_tokens=1024,
        extra_body={"enable_thinking":False}
    )
    return llm

# 嵌入模型
def embedding_model():
    embedding = OpenAIEmbeddings(
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
        model="qwen3.7-text-embedding",
        check_embedding_ctx_length=False
    )
    return embedding

###############加载知识库###############
def load_vectorstore():
    # 存在则加载本地向量库
    embeddings = embedding_model()
    if os.path.exists("CHROMA_DIR") and os.listdir("CHROMA_DIR"):
        print("已加载已有向量库")
        return Chroma(persist_directory="CHROMA_DIR",embedding_function=embeddings)
    # 不存在则构建本地向量库
    print("第一次构建向量库...")
    pages = TextLoader(AI_DATA,encoding="utf-8").load()
    print(f"共加载{len(pages)}个文档块")
    # 加载分割策略
    text_splitter = RecursiveCharacterTextSplitter(
        separators=["\n\n","\n"," ","，","。","！","？","；",""],
        chunk_size=500,
        chunk_overlap=100
    )
    chunks = text_splitter.split_documents(pages)
    print(f"共切割{len(chunks)}个片段")
    vs = Chroma.from_documents(documents=chunks,embedding=embeddings,persist_directory="CHROMA_DIR")
    print("向量库构建完成")
    return vs
vectorstore = load_vectorstore()
retriever = vectorstore.as_retriever(search_kwargs={"k":4})

###############定义工具函数###############
# 工具一：知识库检索
@tool
def search_handbook(query:str) -> str:
    """
    在《15个高频AI基础概念大白话通俗讲解》中检索查询与用户所提问题相关的知识概念，在用户询问与AI相关知
    识的基础概念时调用该工具。
    参数query：用户关于AI基础知识概念的提问。如：token是什么？
    """
    docs = retriever.invoke(query)
    if not docs:
        return "未检索到相关内容"
    parts = []
    for i,d in enumerate(docs,1):
        src = os.path.basename(d.metadata.get("source","知识库"))
        parts.append(f"[片段{i}|{src}]\n{d.page_content}")
    return "\n\n".join(parts)

@tool
def get_month() -> str:
    """
    获取当前是几月份。用户询问现在是几月、当前月份时调用该工具。
    不需要传入任何参数。
    """
    return f"{datetime.now().month}月"

# 2-获取某个月的假期情况
@tool
def get_holidays(month: str) -> str:
    """
    查询指定月份有哪些节假日。
    参数month：月份，格式为"X月"。如：5月有什么假期？
    """
    holidays = {
        "1月": ["元旦：1月1日"],
        "2月": ["春节：1月28日-2月3日"],
        "3月": ["元宵节：3月2日-3月4日"],
        "4月": ["清明节：4月4日-6日"],
        "5月": ["劳动节：5月1日-5日"],
        "6月": ["端午节：5月21日-6月19日"],
        "7月": ["7月没有节假日"],
        "8月": ["8月没有节假日"],
        "9月": ["中秋节：9月25日-27日"],
        "10月": ["国庆节：10月1日-7日"],
        "11月": ["11月没有节假日"],
        "12月": ["元旦：12月31日"]
    }
    res = holidays.get(month, [])
    if res:
        return f"{month}有节假日：{'、'.join(res)}"
    return f"{month}没有节假日"

# 3-查询天气
@tool
def get_weather(city: str, lang: str = "zh") -> str:
    """
    查询国内某个城市的实时天气。用户询问天气时调用该工具。
    参数city：城市名称。如：广州、上海。
    """
    url = 'https://uapis.cn/api/v1/misc/weather'
    params = {"city": city, "lang": lang}
    try:
        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        data = res.json()
        # 转成易读文本（此结构我实测过接口返回）
        return f"{data.get('city', city)}当前温度：{data.get('temperature')}°C，天气：{data.get('weather')}，湿度：{data.get('humidity')}%"
    except Exception as e:
        print("请求异常：", e)
        return f"查询天气失败：{e}"

# 4-英语单词查询
@tool
def get_word(word: str, lang: str = "en") -> str:
    """
    查询英语单词的释义。用户问某个单词是什么意思时调用该工具。
    参数word：要查询的英文单词。如：apple。
    """
    url = "https://uapis.cn/api/v1/dictionary/lookup"
    params = {"word": word, "lang": lang}
    try:
        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        return json.dumps(res.json(), ensure_ascii=False)
    except Exception as e:
        print("请求异常：", e)
        return f"查询失败：{e}"

# 5-匹配菜谱
@tool
def get_food(keyword: str) -> str:
    """
    根据食材或菜名关键词查询菜谱。用户问某道菜怎么做时调用该工具。
    参数keyword：食材或菜名关键词。如：番茄、红烧肉。
    """
    url = "https://uapis.cn/api/v1/food/recipe"
    params = {"keyword": keyword}
    try:
        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        return json.dumps(res.json(), ensure_ascii=False)
    except Exception as e:
        print("请求异常：", e)
        return f"查询失败：{e}"

# 6-答案之书
@tool
def get_answer(question: str) -> str:
    """
    向答案之书提问并获得一个神秘的回答，适合用户询问非严肃的、玄学类问题。
    参数question：用户想问的问题。如：我明天会有好运吗？
    """
    url = "https://uapis.cn/api/v1/answerbook/ask"
    data = {"question": question}
    try:
        res = requests.post(url, data=data, timeout=10)
        res.raise_for_status()
        return json.dumps(res.json(), ensure_ascii=False)
    except Exception as e:
        print("请求异常：", e)
        return f"查询失败：{e}"

# 注册工具（langchain 用列表，不是字典）
tools = [search_handbook,get_month, get_holidays, get_weather, get_word, get_food, get_answer]


###############对话记忆###############
# 用 InMemoryChatMessageHistory 管理历史，messages_to_dict / messages_from_dict 做序列化和反序列化
# 每轮对话后落盘到 HISTORY_FILE，下次启动自动读取，实现持久化记忆。

chat_history = InMemoryChatMessageHistory()
# 序列化
def save_session(chat_history:InMemoryChatMessageHistory):
    message_dict = messages_to_dict(chat_history.messages)
    json_str = json.dumps(message_dict,ensure_ascii=False,indent=2)
    with open("chat_history.json","w",encoding="utf-8") as f:
        f.write(json_str)

# 反序列化
def load_session() -> InMemoryChatMessageHistory:
    if os.path.exists("chat_history.json"):
        try:
            with open("chat_history.json","r",encoding="utf-8") as f:
                message_dict = json.load(f)
            messages = messages_from_dict(message_dict)
            return InMemoryChatMessageHistory(messages=messages)
        except Exception as e:
            print(f"会话文件损坏，开启全新对话：{e}")
    return InMemoryChatMessageHistory()

agent = create_agent(
    model=call_qwen(),
    tools=tools,
    system_prompt="""
    你是一个知识问答助手，对简单的问题一般回复200字以内，难回答的问题500字左右，只回答要点，不啰嗦、不重复。

    可用工具及调用时机：
    1. search_handbook：用户问AI基础知识概念（token、大模型等）时调用，从知识库检索回答。
    2. get_month：用户问现在是几月时调用。
    3. get_holidays：用户问某个月的节假日时调用。
    4. get_weather：用户问天气时调用。
    5. get_word：用户问英文单词意思时调用。
    6. get_food：用户问菜谱做法时调用。
    7. get_answer：用户问娱乐、玄学类问题时调用。

    调用工具拿到结果后，用简洁语言直接告诉用户答案即可。
    """
)

if __name__ == "__main__":
    chat_history = load_session()
    if chat_history :
        print("让我们接着聊天吧")
    else:
        print("已开启新会话")
    while True:
        user_message = input("\n你：")
        if user_message == "":
            save_session(chat_history)
            print("会话已保存，下次再聊")
            break

        chat_history.add_user_message(user_message)
        res = agent.invoke({"messages": chat_history.messages})
        ai_answer = res["messages"][-1].content
        chat_history.add_ai_message(ai_answer)
        #对话落盘
        save_session(chat_history)
        print(f"AI：{ai_answer}")