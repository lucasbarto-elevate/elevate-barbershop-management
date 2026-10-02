export const seed = {
  settings:{name:'Elevate Barbershop',currency:'€',commission:50,open:'10:00',close:'20:00'},
  barbers:[
    {id:1,name:'Lucas Carvalho',commission:50,active:true},
    {id:2,name:'Igor',commission:50,active:true},
    {id:3,name:'Ramon',commission:50,active:true},
    {id:4,name:'Elevate Barbershop',commission:0,active:true}
  ],
  services:[
    ['Scalp peeling',30,30],['Skin fade and beard',32,30],['Haircut, Beard, …',52,80],['Kids Haircut Skin Fade',20,30],['Kids Haircut',16,30],['Brazilian Keratin',50,60],['Scissors Cut',27,30],['Haircut Beard …',42,70],['Student School',20,30],['Haircut and Beard Trim',37,60],['Skin Fade',24,30],['Classic Haircut',20,30],['Beard Trim',16,30],['Hot Towel Shave',23,30],['Nose waxing',10,10],['Eyebrowns',5,10],['Combo - offer',30,30],['Line up',10,30],['Scissors student',25,30],['Student College',22,30],['Beard Hydration',20,30],['Hair Hydration',30,30],['Haircut + Hydration',50,30],['Haircut and hot towel',42,60],['ear wax',10,10],['Scissors Cut advanced',45,60],['Beard Pigmentation',15,30]
  ].map((x,i)=>({id:i+1,name:x[0],price:x[1],duration:x[2]})),
  products:[
    {id:1,name:'Matte Red one',stock:0,cost:0,price:0,min:2,commission:0},
    {id:2,name:'Matte Pomade',stock:0,cost:0,price:0,min:2,commission:0},
    {id:3,name:'Numero 7 RED',stock:0,cost:0,price:0,min:2,commission:0},
    {id:4,name:'Sea Salt',stock:0,cost:0,price:0,min:2,commission:0},
    {id:5,name:'Sea Salt - Shave Factory',stock:0,cost:0,price:0,min:2,commission:0},
    {id:6,name:'Bandido Powder',stock:0,cost:0,price:0,min:2,commission:0},
    {id:7,name:'Numero 5 BLUE',stock:0,cost:0,price:0,min:2,commission:0},
    {id:8,name:'Oil Beard',stock:0,cost:0,price:0,min:2,commission:0},
    {id:9,name:'Hair Spray',stock:0,cost:0,price:0,min:2,commission:0},
    {id:10,name:'Hair mousse',stock:0,cost:0,price:0,min:2,commission:0},
    {id:11,name:'Bandido After Shave',stock:0,cost:0,price:0,min:2,commission:0},
    {id:12,name:'Red One After shave',stock:0,cost:0,price:0,min:2,commission:0},
    {id:13,name:'Curl Cream',stock:0,cost:0,price:0,min:2,commission:0}
  ],
  entries:[
    {id:1,date:'2026-10-01',time:'15:05',barber:1,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:0,tipPayment:null,total:24},
    {id:2,date:'2026-10-01',time:'15:00',barber:4,clients:1,service:'Classic Haircut',serviceItems:[{id:12,name:'Classic Haircut',qty:1,unitPrice:20}],productItems:[],payment:'Cash',servicePayment:'Cash',productPayment:null,tip:10,tipPayment:'Cash',total:20},
    {id:3,date:'2026-10-01',time:'14:57',barber:2,clients:1,service:'Kids Haircut Skin Fade',serviceItems:[{id:4,name:'Kids Haircut Skin Fade',qty:1,unitPrice:20}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:3.3,tipPayment:'Cash',total:20},
    {id:4,date:'2026-10-01',time:'14:53',barber:3,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:3.3,tipPayment:'Cash',total:24},
    {id:5,date:'2026-10-01',time:'14:27',barber:4,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'Revolut',servicePayment:'Revolut',productPayment:null,tip:0,tipPayment:null,total:24},
    {id:6,date:'2026-10-01',time:'14:23',barber:3,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:0,tipPayment:null,total:24},
    {id:7,date:'2026-10-01',time:'13:44',barber:1,clients:1,service:'Classic Haircut',serviceItems:[{id:12,name:'Classic Haircut',qty:1,unitPrice:20}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:3,tipPayment:'Cash',total:20},
    {id:8,date:'2026-10-01',time:'13:37',barber:2,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:0,tipPayment:null,total:24},
    {id:9,date:'2026-10-01',time:'12:51',barber:2,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'Cash',servicePayment:'Cash',productPayment:null,tip:1,tipPayment:'Cash',total:24},
    {id:10,date:'2026-10-01',time:'12:46',barber:1,clients:1,service:'Scissors Cut',serviceItems:[{id:7,name:'Scissors Cut',qty:1,unitPrice:27}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:0,tipPayment:null,total:27},
    {id:11,date:'2026-10-01',time:'12:04',barber:2,clients:1,service:'Skin Fade',serviceItems:[{id:11,name:'Skin Fade',qty:1,unitPrice:24}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:0,tipPayment:null,total:24},
    {id:12,date:'2026-10-01',time:'11:51',barber:1,clients:1,service:'Haircut and Beard Trim',serviceItems:[{id:10,name:'Haircut and Beard Trim',qty:1,unitPrice:37}],productItems:[],payment:'SumUp',servicePayment:'SumUp',productPayment:null,tip:3,tipPayment:'Cash',total:37}
  ]
};
