from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / 'docs/panel-prototype/provider-preview'
OUT.mkdir(parents=True, exist_ok=True)
S = 2
FONT = 'C:/Windows/Fonts/msyh.ttc'
INK, MUTED, LINE = '#17191c', '#80858e', '#d9dbdf'

def page(h):
    global im, d
    im = Image.new('RGB', (620*S, h*S), 'white')
    d = ImageDraw.Draw(im)

def box(x,y,w,h,fill='white',border=LINE,r=10):
    d.rounded_rectangle((x*S,y*S,(x+w)*S,(y+h)*S),radius=r*S,fill=fill,outline=border,width=S)

def text(x,y,value,size=14,color=INK):
    d.text((x*S,y*S),value,font=ImageFont.truetype(FONT,size*S),fill=color)

def button(x,y,w,label,primary=False):
    box(x,y,w,36,INK if primary else 'white',INK if primary else LINE,8)
    f=ImageFont.truetype(FONT,14*S)
    tw=d.textlength(label,font=f)/S
    text(x+(w-tw)/2,y+7,label,14,'white' if primary else INK)

def field(y,label,value,placeholder=False,dropdown=False):
    text(28,y,label,13,'#595f68')
    box(28,y+28,564,40,r=8)
    text(40,y+37,value,14,'#b0b5be' if placeholder else INK)
    if dropdown: d.line([(563*S,(y+45)*S),(568*S,(y+50)*S),(573*S,(y+45)*S)],fill=MUTED,width=2*S)

def save(name):
    im.save(OUT / (name+'.png'))

page(620)
text(24,26,'模型',20)
button(452,20,120,'打开配置文件')
text(587,25,'×',20,MUTED)
text(24,72,'填入各提供商的 API 密钥即可使用其模型。',14,MUTED)
for y,name,custom in [(122,'DeepSeek',False),(194,'OpenAI',False),(266,'我的代理',True)]:
    box(24,y,572,60,r=16)
    text(42,y+19,name,15)
    if custom:
        box(114,y+20,52,22,'#fafafa',LINE,5)
        text(122,y+22,'自定义',11,MUTED)
        button(460,y+12,56,'编辑')
        text(540,y+22,'删除',13,'#e65050')
    else: button(520,y+12,56,'编辑')
box(24,344,572,48,'#fafafa','#e1e3e6',12)
text(238,357,'＋ 添加模型提供商',14)
text(24,574,'设计预览 · 示例配置，未连接服务',12,'#a3a7ae')
save('01-models')

for custom in (False,True):
    page(862 if custom else 722)
    box(8,8,604,846 if custom else 706,'#f6f7f8','#f6f7f8',16)
    text(28,24,'添加模型提供商',18)
    text(577,22,'×',21,MUTED)
    box(28,66,356,40,'#e9ebed','#e9ebed',9)
    box(207 if custom else 31,69,174,34,'white','#d8dadd',7)
    text(47,77,'第三方模型提供商',14,MUTED if custom else INK)
    text(229,77,'自定义模型 API',14,INK if custom else MUTED)
    text(28,122,'连接中转站、自部署服务，填写 API 地址、协议和模型。' if custom else '从内置目录选择提供商，填入 API 密钥即可使用。',13,MUTED)
    if custom:
        field(158,'Provider ID','acme-gateway',True)
        text(28,235,'以小写字母开头的唯一标识，例如 my-gateway。',12,MUTED)
        field(266,'显示名称','例如：我的代理',True)
        field(346,'API 地址','https://gateway.example/v1',True)
        field(426,'API 协议','OpenAI Chat Completions',dropdown=True)
        field(506,'API 密钥','输入 API 密钥',True)
        y=596
    else:
        field(158,'提供商','DeepSeek',dropdown=True)
        field(238,'API 密钥','输入 API 密钥',True)
        d.line((28*S,324*S,592*S,324*S),fill=LINE,width=S)
        d.line([(29*S,347*S),(33*S,351*S),(37*S,347*S)],fill=MUTED,width=S)
        text(43,338,'自定义设置',13,'#595f68')
        field(378,'API 地址','提供商默认',True)
        y=466
    d.line((28*S,y*S,592*S,y*S),fill=LINE,width=S)
    text(28,y+18,'模型目录',14)
    text(491,y+19,'获取可用模型',13,'#4a607b')
    if not custom: text(28,y+43,'正在使用适配器默认模型',12,MUTED)
    box(28,y+70,564,60,'#f6f7f8','#d9dbdf',10)
    text(134,y+81,'暂无模型，可获取可用模型或手动添加。',13,MUTED)
    text(154,y+102,'添加后将出现在聊天的模型选择器中。',12,MUTED)
    button(28,y+148,104,'＋ 添加模型')
    button(392,y+200,70,'取消')
    button(474,y+200,118,'创建提供商' if custom else '保存',True)
    text(28,y+210,'设计预览 · 未连接服务',11,'#9ba1aa')
    save('03-custom' if custom else '02-provider')
print('Generated three static design previews:', OUT)
